// The script the launcher adds to the workbench page when it is reached through
// the app's web origin (a remote crew's viewer), so VS Code's "Kiro Crew" tab
// shows Kiro Crew's own chat.
//
// Why a script in the workbench. The tab is a webview, and a webview's content is
// framed by VS Code's own webview origin. The page it should show, the dashboard's
// /embed/chat or /embed/sessions, can only be reached from a remote viewer through the gateway's web
// origin relay, which lets only the dashboard's own origins frame a page (it
// rewrites frame-ancestors, and the webview's origin is not one of them). The
// workbench page itself is served by the launcher, on that same origin, framed
// only by the dashboard. So this script puts the chat in an iframe of the
// workbench's own document, laid over the tab's webview, which stays empty
// underneath. The chat page is then framed by the workbench (same origin) and
// the dashboard, which is exactly the chain the relay allows.
//
// Finding the tab: VS Code names each webview iframe with the extension that owns
// it and its purpose (`...pre/index.html?id=...&extensionId=<id>&purpose=webviewView`,
// webview/browser/webviewElement.ts `_initElement`), so the iframe is the one
// whose src says kiro-crew.kiro-crew-bridge and webviewView. The overlay follows
// its rectangle and hides when the tab is not showing.
//
// Which chat: the page (the vscode-pane module in the dashboard, this
// document's parent) says which of its tabs this window is, and the launcher
// says what that tab shows: the session it was opened from, or the session list.
import { EMBED_PATH_RE } from './kctab.mjs';

const EXTENSION_ID = 'kiro-crew.kiro-crew-bridge';

/** The overlay script for the workbench served under `basePath` (`/vsc-<key>`). */
export function overlayScript(basePath, extensionId = EXTENSION_ID) {
  if (!/^\/[A-Za-z0-9_.-]+$/.test(String(basePath || ''))) throw new Error('bad base path');
  if (!/^[A-Za-z0-9._-]+$/.test(extensionId)) throw new Error('bad extension id');
  return `(function () {
  'use strict';
  var BASE = ${JSON.stringify(basePath)};
  var EXT = ${JSON.stringify(extensionId.toLowerCase())};
  var EMBED = ${EMBED_PATH_RE.toString()};
  var tab = null, box = null, frame = null, embed = '', connected = false, wasShowing = false, el = null, ro = null;

  // Which page tab this window is: the page loads each tab with ?vscpTab=<id>;
  // a window that lost it (it opened another folder itself) asks the page.
  (function askTab() {
    var own = new URLSearchParams(location.search).get('vscpTab') || '';
    if (/^t[0-9a-f]{12}$/.test(own)) {
      tab = own;
      poll();
      return;
    }
    var nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    var settle = function (id) {
      if (tab !== null) return;
      tab = typeof id === 'string' && /^t[0-9a-f]{12}$/.test(id) ? id : '';
      poll();
    };
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (e.source === window.parent && d && d.vscodePane === 'tab' && d.nonce === nonce) settle(d.tab);
    });
    try { window.parent.postMessage({ vscodePane: 'tab?', nonce: nonce }, '*'); } catch (err) { settle(''); }
    setTimeout(function () { settle(''); }, 2500);
  })();

  function findWebview() {
    var list = document.querySelectorAll('iframe.webview');
    for (var i = 0; i < list.length; i++) {
      var src = list[i].getAttribute('src') || '';
      var q = '&' + (src.split('?')[1] || '').toLowerCase();
      if (q.indexOf('&extensionid=' + EXT) >= 0 && q.indexOf('&purpose=webviewview') >= 0) return list[i];
    }
    return null;
  }

  function rectOf(node) {
    if (!node || !node.isConnected) return null;
    var cs = getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;
    var r = node.getBoundingClientRect();
    return r.width >= 40 && r.height >= 40 ? r : null;
  }

  function ensureBox() {
    if (box) return box;
    box = document.createElement('div');
    box.setAttribute('data-vscp-kc-overlay', '');
    box.style.cssText = 'position:fixed;z-index:1000;display:none;overflow:hidden;background:var(--vscode-sideBar-background,#1f1f1f)';
    document.body.appendChild(box);
    return box;
  }

  function dropFrame() {
    if (frame) {
      frame.remove();
      frame = null;
    }
  }

  function sync() {
    var node = findWebview();
    if (node !== el) {
      if (ro) ro.disconnect();
      el = node;
      if (el && window.ResizeObserver) {
        ro = new ResizeObserver(sync);
        ro.observe(el);
      }
    }
    var r = rectOf(el);
    var showing = !!r;
    if (showing && !wasShowing) poll();
    wasShowing = showing;
    if (!showing || !connected || !embed) {
      if (box) box.style.display = 'none';
      if (!connected) dropFrame();
      return;
    }
    var b = ensureBox();
    b.style.left = r.left + 'px';
    b.style.top = r.top + 'px';
    b.style.width = r.width + 'px';
    b.style.height = r.height + 'px';
    b.style.display = 'block';
    if (!frame) {
      frame = document.createElement('iframe');
      frame.setAttribute('title', 'Kiro Crew');
      frame.setAttribute('allow', 'clipboard-read; clipboard-write');
      frame.style.cssText = 'display:block;border:0;width:100%;height:100%;background:var(--vscode-sideBar-background,#1f1f1f)';
      frame.src = embed;
      b.appendChild(frame);
    } else if (frame.getAttribute('data-embed') !== embed) {
      frame.src = embed;
    }
    frame.setAttribute('data-embed', embed);
  }

  function poll() {
    if (tab === null) return; // the page has not said which tab this is yet
    var url = BASE + '/_vscp-kc/state' + (tab ? '?tab=' + encodeURIComponent(tab) : '');
    fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s) return;
        connected = !!s.connected;
        embed = typeof s.embed === 'string' && EMBED.test(s.embed) ? s.embed : '';
        sync();
      })
      .catch(function () {});
  }

  window.addEventListener('resize', sync);
  setInterval(sync, 250);
  setInterval(poll, 3000);
})();
`;
}

/** Add `<script defer src>` before </head>; null when the page has none. `src` is a path on the same origin. */
export function injectScriptTag(html, src) {
  if (!/^\/[A-Za-z0-9/_.-]+$/.test(String(src || ''))) throw new Error('unsafe script path');
  const i = html.search(/<\/head>/i);
  if (i < 0) return null;
  return `${html.slice(0, i)}<script defer src="${src}"></script>${html.slice(i)}`;
}
