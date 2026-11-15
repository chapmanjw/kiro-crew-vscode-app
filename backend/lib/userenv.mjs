// The user's real Windows environment for the VS Code server and its terminals.
//
// The gateway starts app backends with an allowlisted env (kiro_crew/apps/
// registry_pipeline/subprocess_env.py, _SAFE_ENV_KEYS), so terminals opened in
// VS Code would miss USERNAME, PSModulePath, ProgramFiles(x86) and every user
// variable such as GOPATH. Windows itself builds a logon environment from
// HKLM\...\Session Manager\Environment, then HKCU\Environment (Path is
// appended, other user values win), plus per-session values that live in no
// registry key (USERNAME, USERPROFILE, APPDATA, ...). We rebuild the same.

import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** A case-insensitive env map that remembers the first spelling of each name. */
export class EnvMap {
  constructor() {
    this.map = new Map();
  }
  get(name) {
    const e = this.map.get(String(name).toUpperCase());
    return e ? e.value : undefined;
  }
  set(name, value) {
    const key = String(name).toUpperCase();
    const prev = this.map.get(key);
    this.map.set(key, { name: prev ? prev.name : name, value: String(value) });
  }
  delete(name) {
    this.map.delete(String(name).toUpperCase());
  }
  has(name) {
    return this.map.has(String(name).toUpperCase());
  }
  toObject() {
    const out = {};
    for (const { name, value } of this.map.values()) out[name] = value;
    return out;
  }
}

/** Replace %NAME% with values from `lookup`; unknown names stay as written. */
export function expandVars(value, lookup) {
  return String(value).replace(/%([^%;=\r\n]+)%/g, (m, name) => {
    const v = lookup(name);
    return v === undefined ? m : v;
  });
}

/**
 * Per-session variables Windows sets at logon that are not in the registry.
 * `env` is the launcher's (possibly stripped) env, used where it has a value.
 */
export function sessionVars(env, { homedir = os.homedir(), username = safeUsername(), hostname = os.hostname(), cpus = os.cpus().length } = {}) {
  const get = (n) => {
    const k = Object.keys(env).find((x) => x.toUpperCase() === n.toUpperCase());
    return k ? env[k] : undefined;
  };
  const systemRoot = get('SystemRoot') || get('WINDIR') || 'C:\\Windows';
  const systemDrive = get('SystemDrive') || systemRoot.slice(0, 2);
  const programFiles = get('ProgramW6432') || get('ProgramFiles') || `${systemDrive}\\Program Files`;
  const programFilesX86 = get('ProgramFiles(x86)') || `${systemDrive}\\Program Files (x86)`;
  const programData = get('ProgramData') || `${systemDrive}\\ProgramData`;
  const vars = {
    SystemRoot: systemRoot,
    SystemDrive: systemDrive,
    USERNAME: get('USERNAME') || username,
    USERDOMAIN: get('USERDOMAIN') || (get('COMPUTERNAME') || hostname).toUpperCase(),
    COMPUTERNAME: get('COMPUTERNAME') || hostname.toUpperCase(),
    USERPROFILE: homedir,
    HOMEDRIVE: /^[A-Za-z]:/.test(homedir) ? homedir.slice(0, 2) : systemDrive,
    HOMEPATH: /^[A-Za-z]:/.test(homedir) ? homedir.slice(2) || '\\' : homedir,
    APPDATA: get('APPDATA') || path.win32.join(homedir, 'AppData', 'Roaming'),
    LOCALAPPDATA: get('LOCALAPPDATA') || path.win32.join(homedir, 'AppData', 'Local'),
    ProgramFiles: programFiles,
    'ProgramFiles(x86)': programFilesX86,
    ProgramW6432: programFiles,
    CommonProgramFiles: `${programFiles}\\Common Files`,
    'CommonProgramFiles(x86)': `${programFilesX86}\\Common Files`,
    CommonProgramW6432: `${programFiles}\\Common Files`,
    ProgramData: programData,
    ALLUSERSPROFILE: programData,
    PUBLIC: get('PUBLIC') || `${systemDrive}\\Users\\Public`,
    NUMBER_OF_PROCESSORS: String(cpus),
  };
  return vars;
}

function safeUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

/**
 * Build the logon environment: session vars, then machine, then user values
 * (user Path appended to machine Path), with %VAR% expansion.
 * @param {{machine:Record<string,string>, user:Record<string,string>, session:Record<string,string>}} p
 * @returns {Record<string,string>}
 */
export function mergeWindowsEnv({ machine = {}, user = {}, session = {} }) {
  const env = new EnvMap();
  for (const [k, v] of Object.entries(session)) env.set(k, v);
  for (const [k, v] of Object.entries(machine)) if (v != null) env.set(k, v);
  for (const [k, v] of Object.entries(user)) {
    if (v == null) continue;
    if (k.toUpperCase() === 'PATH' && env.get('Path')) env.set(k, `${env.get('Path').replace(/;+$/, '')};${v}`);
    else env.set(k, v);
  }
  // Expand in a few passes so a value can refer to one that is itself expanded.
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const { name, value } of [...env.map.values()]) {
      const next = expandVars(value, (n) => env.get(n));
      if (next !== value) {
        env.set(name, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return env.toObject();
}

// Reads both registry keys without expanding REG_EXPAND_SZ values: the
// launcher's own env may be stripped, so expansion must use the merged env.
const READ_REGISTRY_PS = `
$ErrorActionPreference = 'Stop'
$o = @{}
$keys = @{
  machine = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment')
  user = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
}
foreach ($scope in $keys.Keys) {
  $h = @{}
  $k = $keys[$scope]
  if ($k) { foreach ($n in $k.GetValueNames()) { if ($n) { $h[$n] = [string]$k.GetValue($n, $null, 'DoNotExpandEnvironmentNames') } } }
  $o[$scope] = $h
}
$o | ConvertTo-Json -Compress -Depth 3
`;

/** Read HKLM and HKCU environment values (raw). Returns null when it fails. */
export function readRegistryEnv(env = process.env) {
  if (process.platform !== 'win32') return null;
  const root = env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows';
  const ps = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(READ_REGISTRY_PS, 'utf16le').toString('base64');
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const parsed = JSON.parse(r.stdout.trim());
    return { machine: parsed.machine || {}, user: parsed.user || {} };
  } catch {
    return null;
  }
}

/** The user's logon environment on Windows, or null off Windows / on failure. */
export function windowsUserEnv(env = process.env) {
  const reg = readRegistryEnv(env);
  if (!reg) return null;
  return mergeWindowsEnv({ ...reg, session: sessionVars(env) });
}
