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

/**
 * Environment for the server: the launcher's own env minus secrets, plus the
 * bridge address and secret the companion extension reads.
 * KIROCREW_SPAWNED/KIROCREW_SPAWN_INSTANCE stay so the gateway can reap the tree.
 */
export function buildServerEnv(baseEnv, { bridgeUrl, bridgeSecret }) {
  const env = {};
  const stripped = new Set(STRIPPED_ENV.map((k) => k.toUpperCase()));
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined) continue;
    if (stripped.has(k.toUpperCase())) continue;
    if (k.toUpperCase().startsWith('VSCODE_')) continue; // never let a host VS Code's IPC vars bleed in
    env[k] = v;
  }
  env.KIROCREW_VSCODE_BRIDGE_URL = bridgeUrl;
  env.KIROCREW_VSCODE_BRIDGE_SECRET = bridgeSecret;
  return env;
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
