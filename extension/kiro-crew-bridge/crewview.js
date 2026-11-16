// The HTML of the "Kiro Crew" webview view (pure, so tests can load it).
//
// Signed in: one full-size iframe on the launcher's tunnel origin at
// /embed/chat/<slot> (backend/lib/kcproxy.mjs), which is Kiro Crew's own live
// dashboard chat with its session tabs. Not signed in: a short panel with
// Connect (the vscode-pane page, already inside the signed-in dashboard, mints
// the link) and a field to paste a `kirocrew token` link.
'use strict';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The tunnel origin, only if it is exactly http://<32 hex>.localhost:<port>. */
function tunnelOrigin(origin) {
  const s = String(origin || '');
  return /^http:\/\/[0-9a-f]{32}\.localhost:\d{1,5}$/.test(s) ? s : '';
}

/** What the view shows for a GET /api/bridge/kc answer: 'frame', 'signin', 'nofolder' or 'unavailable'. */
function viewMode(kc) {
  if (!kc || !kc.available || !tunnelOrigin(kc.origin)) return 'unavailable';
  if (!kc.slot) return 'nofolder';
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

/**
 * @param {object} kc     GET /api/bridge/kc
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
    const src = `${origin}/embed/chat/${encodeURIComponent(kc.slot)}`;
    return `${head}<body data-mode="frame"><iframe id="kc" title="Kiro Crew" src="${esc(src)}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
const f = document.getElementById('kc');
const show = () => f.setAttribute('data-loaded', '1');
f.addEventListener('load', show);
setTimeout(show, 10000); // a page that never fires load must not stay invisible
</script></body></html>`;
  }
  let body;
  if (mode === 'unavailable') {
    body = `<h2>Kiro Crew</h2><p class="muted">${esc((kc && kc.reason) || 'The Kiro Crew tunnel is not running. Open VS Code from the Kiro Crew app.')}</p>`;
  } else if (mode === 'nofolder') {
    body = '<h2>Kiro Crew</h2><p class="muted">Open a folder to chat with Kiro Crew about it.</p>';
  } else {
    const err = kc.lastError ? `<p class="err">Last attempt: ${esc(kc.lastError)}</p>` : '';
    body = `<h2>Connect this tab to Kiro Crew</h2>
<p class="muted">The tab shows Kiro Crew's own chat for this folder. It signs in with a link from the Kiro Crew dashboard around VS Code.</p>${err}
<div class="row"><button id="connect" type="button">Connect</button></div>
<div class="row"><label for="link" class="muted">Or paste a sign-in link (from <code>kirocrew token</code> or <code>/kirocrew dashboard</code>):</label>
<input id="link" type="password" autocomplete="off" spellcheck="false" placeholder="http://localhost:5476/?token=..."><button id="paste" type="button">Sign in</button></div>`;
  }
  return `${head}<body data-mode="${mode}"><div class="panel">${body}</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const q = (id) => document.getElementById(id);
if (q('connect')) q('connect').onclick = () => { q('connect').disabled = true; q('connect').textContent = 'Connecting...'; vscode.postMessage({ type: 'connect' }); };
if (q('paste')) q('paste').onclick = () => { const v = q('link').value.trim(); q('link').value = ''; if (v) vscode.postMessage({ type: 'paste', url: v }); };
if (q('link')) q('link').onkeydown = (e) => { if (e.key === 'Enter') q('paste').click(); };
</script></body></html>`;
}

module.exports = { crewViewHtml, viewMode, tunnelOrigin };
