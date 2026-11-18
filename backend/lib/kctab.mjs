// Small pure rules for the Kiro Crew tab (backend/launcher.mjs).
import { validSessionKey } from './tabs.mjs';

/**
 * What VS Code's "Kiro Crew" view shows for a page tab, as a path on the
 * dashboard (lib/kcproxy.mjs serves the dashboard on the tunnel origin): the
 * chat session the tab was opened from, the way the dashboard's own embed tabs
 * open one (`/embed/chat/<key>?sid=<key>`), or the dashboard's session list with
 * its New button (`/embed/sessions`) for a tab opened any other way. Nothing is
 * created: a new session is made only from that list, by the user.
 */
export function embedPathFor(session) {
  const key = validSessionKey(session);
  if (!key) return '/embed/sessions';
  const k = encodeURIComponent(key);
  return `/embed/chat/${k}?sid=${k}`;
}

/** The embed paths embedPathFor makes, and nothing else (the extension and the overlay check the same shape). */
export const EMBED_PATH_RE = /^\/embed\/(?:sessions|chat\/[A-Za-z0-9._%-]{1,600}\?sid=[A-Za-z0-9._%-]{1,600})$/;

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

/**
 * What the "Kiro Crew" tab is told when the workbench was last loaded through
 * the app web origin (a remote crew's viewer). Its own frame cannot reach the
 * tunnel on the launcher's loopback, so the tab draws no frame: the chat is laid
 * over it by the script the launcher adds to the workbench (lib/overlay.mjs).
 * The tunnel's address is withheld; the tab only needs to know to stay empty.
 */
export function overlayTabBody(body) {
  const { origin, embedUrl, ...rest } = body || {};
  return { ...rest, overlay: true };
}
