// Route table for the launcher. `auth` says which check a route needs:
//   none   - unsigned loopback GET the gateway's health check makes
//   proxy  - reached through the Kiro Crew proxy, carries X-KiroCrew-Proxy
//   bridge - called directly by the VS Code extension with the bridge secret
//   frame  - the VS Code workbench, gated by the unguessable path prefix

export const ROUTES = [
  { method: 'GET', path: '/health', name: 'health', auth: 'none' },
  { method: 'GET', path: '/api/session', name: 'session', auth: 'proxy' },
  { method: 'GET', path: '/api/state', name: 'state', auth: 'proxy' },
  { method: 'POST', path: '/api/open', name: 'open', auth: 'proxy' },
  { method: 'POST', path: '/api/restart', name: 'restart', auth: 'proxy' },
  { method: 'POST', path: '/api/file-menu', name: 'fileMenu', auth: 'proxy' },
  { method: 'GET', path: '/api/theme', name: 'themeGet', auth: 'proxy' },
  { method: 'POST', path: '/api/theme', name: 'theme', auth: 'proxy' },
  { method: 'GET', path: '/api/chat/status', name: 'chatStatus', auth: 'proxy' },
  { method: 'POST', path: '/api/chat/ask', name: 'chatAsk', auth: 'proxy' },
  { method: 'GET', path: '/api/chat/prefs', name: 'chatPrefsGet', auth: 'proxy' },
  { method: 'POST', path: '/api/chat/prefs', name: 'chatPrefs', auth: 'proxy' },
  { method: 'POST', path: '/api/chat/open-session', name: 'chatOpenSession', auth: 'proxy' },
  { method: 'POST', path: '/api/crew/view', name: 'crewView', auth: 'proxy' },
  { method: 'POST', path: '/api/secret-probe', name: 'secretProbe', auth: 'proxy' },
  { method: 'GET', path: '/api/bridge/commands', name: 'bridgeCommands', auth: 'bridge' },
  { method: 'POST', path: '/api/bridge/events', name: 'bridgeEvents', auth: 'bridge' },
  { method: 'POST', path: '/api/bridge/chat', name: 'bridgeChat', auth: 'bridge' },
  { method: 'GET', path: '/api/bridge/sessions', name: 'bridgeSessions', auth: 'bridge' },
  { method: 'POST', path: '/api/bridge/sessions', name: 'bridgeSessionCreate', auth: 'bridge' },
  { method: 'GET', path: '/api/bridge/sessions/history', name: 'bridgeSessionHistory', auth: 'bridge' },
  { method: 'POST', path: '/api/bridge/approve', name: 'bridgeApprove', auth: 'bridge' },
  { method: 'POST', path: '/api/bridge/question', name: 'bridgeQuestion', auth: 'bridge' },
];

/**
 * @returns {{name:string, auth:string}|{error:number}}
 */
export function matchRoute(method, pathname, framePrefix) {
  if (framePrefix && (pathname === framePrefix || pathname.startsWith(framePrefix + '/'))) {
    return { name: 'frame', auth: 'frame' };
  }
  const byPath = ROUTES.filter((r) => r.path === pathname);
  if (byPath.length === 0) return { error: 404 };
  const hit = byPath.find((r) => r.method === method);
  if (!hit) return { error: 405 };
  return { name: hit.name, auth: hit.auth };
}

/** Validate and normalise an open request body. */
export function parseOpenRequest(body) {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const kind = body.kind || 'openFile';
  if (!['openFile', 'openFolder', 'revealInExplorer'].includes(kind)) {
    return { error: `unknown kind ${JSON.stringify(kind)}` };
  }
  const p = typeof body.path === 'string' ? body.path.trim() : '';
  if (!p) return { error: 'path is required' };
  if (p.length > 4096 || p.includes('\0')) return { error: 'path is invalid' };
  const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  const line = num(body.line);
  const column = num(body.column);
  for (const [k, v] of [['line', line], ['column', column]]) {
    if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > 10_000_000)) {
      return { error: `${k} must be a positive integer` };
    }
  }
  const cmd = { kind, path: p };
  if (line !== undefined) cmd.line = line;
  if (column !== undefined) cmd.column = column;
  return { command: cmd };
}

/**
 * contributes.fileMenuItems POSTs `{item_id, surface, path, kind?, root?}`
 * (KiroCrew docs/app-kit/manifest-reference.md, fileMenuItems).
 */
export function fileMenuToCommand(body) {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const isDir = body.kind === 'dir' || body.surface === 'folder-row';
  return parseOpenRequest({ kind: isDir ? 'openFolder' : 'openFile', path: body.path });
}
