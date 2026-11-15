// Small pure rules for the Kiro Crew tab (backend/launcher.mjs).

/**
 * Whether GET /api/bridge/kc may name and create the folder's crew slot.
 * The slot is created only when the tab opens (`opened`), only for an absolute
 * folder that exists and that the calling VS Code window has open. A folder
 * that fails those checks is refused; a poll without `opened` only names it.
 * @returns {{folder: string, ensure: boolean} | {error: string}}
 */
export function crewSlotRequest({ folder, opened, roots, isAbsolute, exists, inRoots }) {
  const f = typeof folder === 'string' ? folder : '';
  if (!f || !isAbsolute(f) || !exists(f)) return { error: 'folder must be an absolute path that exists' };
  if (!inRoots(f, roots)) return { error: 'folder is not open in this VS Code window' };
  return { folder: f, ensure: !!opened };
}

/**
 * The dashboard origins allowed to frame the chain: the gateway's own origin
 * (KIROCREW_GATEWAY_ORIGIN) in its localhost and 127.0.0.1 spellings, plus
 * VSCODE_PANE_DASHBOARD_ORIGIN (comma separated) for a dashboard served from
 * elsewhere, such as the smoke test's stand-in. Loopback http origins only.
 */
export function dashboardOrigins(env) {
  const out = new Set();
  const add = (v) => {
    try {
      const u = new URL(String(v || '').trim());
      if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname)) return;
      out.add(u.origin);
      const twin = u.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
      out.add(`http://${twin}${u.port ? ':' + u.port : ''}`);
    } catch {
      /* ignored */
    }
  };
  add(env.KIROCREW_GATEWAY_ORIGIN);
  for (const v of String(env.VSCODE_PANE_DASHBOARD_ORIGIN || '').split(',')) add(v);
  return [...out];
}
