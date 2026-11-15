// Command line and environment for the VS Code server child process.

import path from 'node:path';

/**
 * Arguments for `node out/server-main.js`.
 * The server is started directly, not through `code serve-web`, because the
 * CLI wrapper adds X-Frame-Options/frame-ancestors (R1-B section 2).
 */
export function buildServerArgs({ host = '127.0.0.1', port, tokenFile, dataDir, workspace, basePath }) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('invalid port');
  if (!tokenFile) throw new Error('tokenFile required');
  const args = [
    path.join('out', 'server-main.js'),
    '--host', host,
    '--port', String(port),
    '--connection-token-file', tokenFile,
    '--accept-server-license-terms',
    '--server-data-dir', path.join(dataDir, 'server-data'),
    '--extensions-dir', path.join(dataDir, 'extensions'),
    '--disable-telemetry',
  ];
  if (basePath) args.push('--server-base-path', basePath);
  if (workspace) args.push('--default-folder', workspace);
  return args;
}

/** Variables that must not leak into VS Code (its terminals and extensions inherit them). */
export const STRIPPED_ENV = [
  'KIROCREW_PROXY_SECRET',
  'KIROCREW_GATEWAY_ORIGIN_PROOF',
  'PORT',
  'NODE_ENV',
  'VSCODE_PANE_DATA_DIR',
];

/** Gateway tracking variables: kept on the server process, removed from terminals. */
export const TRACKING_ENV = ['KIROCREW_SPAWNED', 'KIROCREW_SPAWN_INSTANCE'];

/**
 * Environment for the server.
 *
 * With `userEnv` (Windows: the user's logon environment from userenv.mjs) the
 * server starts from that instead of the gateway's allowlisted env, so VS Code
 * terminals look like terminals the user opened. Only the gateway's tracking
 * variables are carried over from the launcher, so the gateway's Linux orphan
 * reap still recognises the server's process group; terminals drop them again
 * through terminalEnvSettings(). Without `userEnv` the launcher env is used.
 * Secrets in STRIPPED_ENV and any host VSCODE_* variables are always removed.
 */
export function buildServerEnv(baseEnv, { bridgeUrl, bridgeSecret, userEnv = null }) {
  const env = {};
  const stripped = new Set(STRIPPED_ENV.map((k) => k.toUpperCase()));
  const add = (k, v) => {
    if (v === undefined || v === null) return;
    if (stripped.has(k.toUpperCase())) return;
    if (k.toUpperCase().startsWith('VSCODE_')) return; // never let a host VS Code's IPC vars bleed in
    env[k] = String(v);
  };
  if (userEnv) {
    for (const [k, v] of Object.entries(userEnv)) add(k, v);
    for (const name of TRACKING_ENV) {
      const k = Object.keys(baseEnv).find((x) => x.toUpperCase() === name);
      if (k) add(name, baseEnv[k]);
    }
  } else {
    for (const [k, v] of Object.entries(baseEnv)) add(k, v);
  }
  env.KIROCREW_VSCODE_BRIDGE_URL = bridgeUrl;
  env.KIROCREW_VSCODE_BRIDGE_SECRET = bridgeSecret;
  return env;
}

/** Variables VS Code terminals must not inherit from the server process. */
export const TERMINAL_UNSET = [...TRACKING_ENV, 'KIROCREW_VSCODE_BRIDGE_URL', 'KIROCREW_VSCODE_BRIDGE_SECRET'];

/**
 * Rewrite the server's Machine settings.json so integrated terminals unset
 * TERMINAL_UNSET (`terminal.integrated.env.<os>` with `null` deletes a
 * variable). Other settings are kept. Returns null when the existing file is
 * not plain JSON (for example it has comments), so a user's file is never
 * clobbered.
 */
export function terminalEnvSettings(existingText) {
  let obj = {};
  if (existingText && existingText.trim()) {
    try {
      obj = JSON.parse(existingText);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  }
  for (const osName of ['windows', 'linux', 'osx']) {
    const key = `terminal.integrated.env.${osName}`;
    const cur = obj[key] && typeof obj[key] === 'object' ? obj[key] : {};
    const next = { ...cur };
    for (const name of TERMINAL_UNSET) next[name] = null;
    obj[key] = next;
  }
  return JSON.stringify(obj, null, 2) + '\n';
}

/**
 * The `folder` query value the web workbench expects. With a remote authority,
 * a value starting with `/` is read as a vscode-remote path
 * (vscode/src/vs/code/browser/workbench/workbench.ts:429-437).
 */
export function toFolderParam(folder) {
  if (!folder) return null;
  let p = String(folder).replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(p)) p = '/' + p;
  if (!p.startsWith('/')) return null;
  return p;
}

export function workbenchUrl({ host = '127.0.0.1', port, basePath, folder }) {
  const base = `http://${host}:${port}${basePath || ''}/`;
  const f = toFolderParam(folder);
  return f ? `${base}?folder=${encodeURIComponent(f)}` : base;
}
