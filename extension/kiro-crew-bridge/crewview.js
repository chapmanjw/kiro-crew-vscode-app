// The HTML of the "Kiro Crew" webview view (pure, so tests can load it).
//
// Signed in: one full-size iframe on the launcher's tunnel origin
// (backend/lib/kcproxy.mjs) showing Kiro Crew's own live dashboard: the chat
// session this window's page tab was opened from (/embed/chat/<key>?sid=<key>),
// or the session list with its New button (/embed/sessions) for a tab opened
// any other way. Not signed in: a short panel with Connect (the vscode-pane
// page, already inside the signed-in dashboard, mints the link) and a field to
// paste a `kirocrew token` link.
//
// Every version of the page first asks the vscode-pane page, the dashboard
// document at the top of the frame chain, which of its tabs this window is,
// and tells the extension (backend/lib/tabs.mjs). No answer within 2.5 s (VS
// Code opened outside the page) means none.
'use strict';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The tunnel origin, only if it is exactly http://<32 hex>.localhost:<port>. */
function tunnelOrigin(origin) {
  const s = String(origin || '');
  return /^http:\/\/[0-9a-f]{32}\.localhost:\d{1,5}$/.test(s) ? s : '';
}

/** The dashboard paths the view may frame (backend/lib/kctab.mjs embedPathFor makes them). */
const EMBED_PATH_RE = /^\/embed\/(?:sessions|chat\/[A-Za-z0-9._%-]{1,600}\?sid=[A-Za-z0-9._%-]{1,600})$/;

/** What to frame: the launcher's embed path when it has the expected shape, else the session list. */
function embedPath(kc) {
  const p = kc && kc.embedPath;
  return typeof p === 'string' && EMBED_PATH_RE.test(p) ? p : '/embed/sessions';
}

/**
 * What the view shows for a GET /api/bridge/kc answer: 'pending' (the page has
 * not said which tab this is yet), 'frame', 'overlay', 'signin' or
 * 'unavailable'. 'overlay' is a remote crew's viewer: the chat is not framed
 * here but laid over this view by the workbench page (backend/lib/overlay.mjs),
 * so the view stays an empty placeholder.
 */
function viewMode(kc) {
  if (kc && kc.pending) return 'pending';
  if (kc && kc.overlay) {
    if (!kc.available) return 'unavailable';
    return kc.connected ? 'overlay' : 'signin';
  }
  if (!kc || !kc.available || !tunnelOrigin(kc.origin)) return 'unavailable';
  return kc.connected ? 'frame' : 'signin';
}

const STYLE = `html,body{height:100%;margin:0;padding:0;overflow:hidden;background:var(--vscode-sideBar-background)}
iframe{display:block;border:0;width:100%;height:100%;background:var(--vscode-sideBar-background)}
/* Hidden until the framed page has loaded, so its own white canvas never shows. */
iframe:not([data-loaded]){opacity:0}
.panel{box-sizing:border-box;height:100%;overflow:auto;padding:16px;font:13px var(--vscode-font-family);color:var(--vscode-foreground);line-height:1.45}
.panel h2{font-size:13px;margin:0 0 8px}
.muted{color:var(--vscode-descriptionForeground)}
.err{color:var(--vscode-errorForeground);margin:8px 0}
button{font:inherit;padding:4px 12px;border:0;border-radius:2px;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
button:hover{background:var(--vscode-button-hoverBackground)}
input{font:inherit;width:100%;box-sizing:border-box;margin:6px 0;padding:4px 6px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent)}
.row{margin:12px 0}`;

// Ask the page which tab this window is, then report it (or null) to the extension once.
const ASK_TAB = `(() => {
  const asked = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let settled = false;
  const settle = (tab) => {
    if (settled) return;
    settled = true;
    vscode.postMessage({ type: 'paneTab', tab: typeof tab === 'string' ? tab : null });
  };
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && typeof d === 'object' && d.vscodePane === 'tab' && d.nonce === asked) settle(d.tab);
  });
  try { window.top.postMessage({ vscodePane: 'tab?', nonce: asked }, '*'); } catch (e) { settle(null); }
  setTimeout(() => settle(null), 2500);
})();`;

/**
 * @param {object} kc     GET /api/bridge/kc, plus `pending` while the tab is not known
 * @param {string} nonce  script nonce
 */
function crewViewHtml(kc, nonce) {
  const mode = viewMode(kc);
  const origin = tunnelOrigin(kc && kc.origin);
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    origin ? `frame-src ${origin}` : null,
  ].filter(Boolean).join('; ');
  const head = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${STYLE}</style></head>`;
  if (mode === 'frame') {
    const src = `${origin}${embedPath(kc)}`;
    return `${head}<body data-mode="frame"><iframe id="kc" title="Kiro Crew" src="${esc(src)}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
${ASK_TAB}
const f = document.getElementById('kc');
const show = () => f.setAttribute('data-loaded', '1');
f.addEventListener('load', show);
setTimeout(show, 10000); // a page that never fires load must not stay invisible
</script></body></html>`;
  }
  let body;
  if (mode === 'pending' || mode === 'overlay') {
    body = '<p class="muted">Opening the Kiro Crew chat...</p>';
  } else if (mode === 'unavailable') {
    body = `<h2>Kiro Crew</h2><p class="muted">${esc((kc && kc.reason) || 'The Kiro Crew tunnel is not running. Open VS Code from the Kiro Crew app.')}</p>`;
  } else {
    const err = kc.lastError ? `<p class="err">Last attempt: ${esc(kc.lastError)}</p>` : '';
    const what = kc.session ? 'the Kiro Crew chat this tab was opened from' : 'your Kiro Crew sessions';
    body = `<h2>Connect this tab to Kiro Crew</h2>
<p class="muted">The tab shows ${what}. It signs in with a link from the Kiro Crew dashboard around VS Code.</p>${err}
<div class="row"><button id="connect" type="button">Connect</button></div>
<div class="row"><label for="link" class="muted">Or paste a sign-in link (from <code>kirocrew token</code> or <code>/kirocrew dashboard</code>):</label>
<input id="link" type="password" autocomplete="off" spellcheck="false" placeholder="http://localhost:5476/?token=..."><button id="paste" type="button">Sign in</button></div>`;
  }
  return `${head}<body data-mode="${mode}"><div class="panel">${body}</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
${ASK_TAB}
const q = (id) => document.getElementById(id);
if (q('connect')) q('connect').onclick = () => { q('connect').disabled = true; q('connect').textContent = 'Connecting...'; vscode.postMessage({ type: 'connect' }); };
if (q('paste')) q('paste').onclick = () => { const v = q('link').value.trim(); q('link').value = ''; if (v) vscode.postMessage({ type: 'paste', url: v }); };
if (q('link')) q('link').onkeydown = (e) => { if (e.key === 'Enter') q('paste').click(); };
</script></body></html>`;
}

module.exports = { crewViewHtml, viewMode, tunnelOrigin, embedPath, EMBED_PATH_RE };
