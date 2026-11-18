// The bootstrap the tunnel adds to the Kiro Crew embed pages (backend/lib/kcproxy.mjs).
//
// The embed keeps its open tabs in sessionStorage, under kirocrew-embed-tabs and
// kirocrew-embed-active-index. Every embed on the tunnel's origin inside one dashboard tab
// shares that storage, and the Kiro Crew view of each VS Code tab is such an embed, so a
// view opened on the session list showed whichever chat another view had last active.
//
// This script gives each view its own tabs. A view is told apart by an id that the script
// keeps in window.name, which belongs to the view's frame and survives the frame's own page
// loads. The tabs themselves are kept in sessionStorage under that id, so window.name holds
// nothing but the id. The embed's reads and writes of the two keys go to the view's tabs. A
// new view starts from its URL: the chat it names, or the session list.
//
// The embed's tab strip also has a fault. It copies the store's active chat into the
// Sessions tab whenever the route changes, so closing the last chat tab, clicking "+", or
// clicking the Sessions tab turned that tab back into the chat the store still held, or into
// the first chat in the list. A page that loads fresh on the list does not do this. So when
// the strip moves from a chat page to the session list, this script holds that move back,
// lets the strip save its tabs, freezes the page, and loads the list page again. The saved
// tabs rebuild the strip, so the other tabs stay.
//
// It depends on the names the dashboard's bundle uses: the two storage keys, the
// kirocrew-tab-update event, and the routes /embed/chat/<slug> and /embed/sessions. If an
// update renames one of them, that part does nothing and the embed keeps its own behaviour.

/** Where the tunnel serves the script, on its own origin (not forwarded to the gateway). */
export const EMBED_BOOT_PATH = '/_vscp-kc/embed.js';

export const EMBED_BOOT_SOURCE = `(function () {
  'use strict';
  var TABS = 'kirocrew-embed-tabs';
  var INDEX = 'kirocrew-embed-active-index';
  var NAME = 'vscp-kc:';
  var SAVED = 'vscp-kc-view:';
  var LIST = /^\\/embed\\/sessions\\/?$/;
  var CHAT = /^\\/embed\\/chat\\/([^\\/]+)$/;
  var view = null;
  var id = null;
  var leaving = false;
  var frozen = false;
  var ss = null;
  try { ss = window.sessionStorage; } catch (e) { ss = null; }
  var getItem = Storage.prototype.getItem;
  var setItem = Storage.prototype.setItem;

  function isText(t) { return typeof t === 'string' && t.length <= 300; }
  function sound(v) {
    return !!v && Array.isArray(v.tabs) && v.tabs.length > 0 && v.tabs.length <= 50 && v.tabs.every(isText) &&
      Number.isInteger(v.index) && v.index >= 0 && v.index < v.tabs.length;
  }
  function load() {
    try {
      var v = JSON.parse(getItem.call(ss, SAVED + id));
      return sound(v) ? v : null;
    } catch (e) { return null; }
  }
  function save() {
    if (!id || frozen || !ss) return;
    try { setItem.call(ss, SAVED + id, JSON.stringify(view)); } catch (e) {}
  }
  function claim() {
    var n = String(window.name || '');
    if (n.indexOf(NAME) === 0 && /^[0-9a-f]{16}$/.test(n.slice(NAME.length))) return n.slice(NAME.length);
    if (n !== '') return null;
    var a = new Uint8Array(8);
    crypto.getRandomValues(a);
    var h = '';
    for (var i = 0; i < a.length; i++) h += (a[i] < 16 ? '0' : '') + a[i].toString(16);
    window.name = NAME + h;
    return h;
  }

  // 1. This view's tabs: the ones saved for its id when they fit this page, else the page's own.
  //    The chat is named by ?sid= (the real key); the path carries a title slug once the embed
  //    has rewritten it, which is not a key.
  try {
    var slug = null;
    var m = CHAT.exec(location.pathname);
    if (m) {
      slug = decodeURIComponent(m[1]);
      var sid = new URLSearchParams(location.search).get('sid');
      if (sid && isText(sid)) slug = sid;
    } else if (LIST.test(location.pathname)) {
      slug = '';
    }
    if (slug !== null) {
      try { id = claim(); } catch (e) { id = null; }
      var v = id ? load() : null;
      var at = v ? v.tabs.indexOf(slug) : -1;
      if (v && at >= 0) {
        if (!(slug === '' && v.tabs[v.index] === '')) v.index = at;
        view = v;
      } else {
        view = { tabs: [slug], index: 0 };
      }
      save();
    }
  } catch (e) { view = null; }

  // 2. The embed reads and writes its two tab keys through this view's tabs.
  try {
    if (!ss) throw new Error('no session storage');
    Storage.prototype.getItem = function (key) {
      if (view && this === ss) {
        if (key === TABS) return JSON.stringify(view.tabs);
        if (key === INDEX) return String(view.index);
      }
      return getItem.apply(this, arguments);
    };
    Storage.prototype.setItem = function (key, value) {
      if (view && this === ss && (key === TABS || key === INDEX)) {
        if (frozen) return;
        try {
          if (key === TABS) {
            var t = JSON.parse(value);
            if (Array.isArray(t) && t.length > 0 && t.length <= 50 && t.every(isText)) {
              view.tabs = t;
              if (view.index >= t.length) view.index = t.length - 1;
            }
          } else {
            var i = Number(value);
            if (Number.isInteger(i) && i >= 0 && i < view.tabs.length) view.index = i;
          }
          save();
        } catch (e) {}
        return;
      }
      return setItem.apply(this, arguments);
    };
  } catch (e) {}

  // 3. A move from a chat page to the session list loads the list page again instead. The
  //    strip saves its tabs right after it navigates and says so with kirocrew-tab-update;
  //    from then on this page changes nothing, so effects still running in it cannot undo
  //    what the strip saved.
  function toList(url) {
    try { return LIST.test(new URL(String(url), location.href).pathname); } catch (e) { return false; }
  }
  function leave() {
    if (leaving) return;
    leaving = true;
    setTimeout(function () { location.replace('/embed/sessions'); }, 0);
    setTimeout(function () { frozen = true; }, 50);
    setTimeout(function () { leaving = false; frozen = false; }, 5000);
  }
  try {
    var push = history.pushState;
    var replace = history.replaceState;
    history.pushState = function (state, title, url) {
      if (frozen) return;
      if (view && url != null && !LIST.test(location.pathname) && toList(url)) { leave(); return; }
      return push.apply(this, arguments);
    };
    history.replaceState = function () {
      if (frozen) return;
      return replace.apply(this, arguments);
    };
    window.addEventListener('kirocrew-tab-update', function () { if (leaving) frozen = true; });
  } catch (e) {}
})();
`;

/** Whether a request path is one of the dashboard's embed pages (/embed/chat/..., /embed/sessions, ...). */
export function isEmbedPath(pathname) {
  return /^\/embed(\/|$)/.test(String(pathname || ''));
}

/** The script element that loads the bootstrap. */
export function embedBootTag() {
  return `<script src="${EMBED_BOOT_PATH}"></script>`;
}

/** `tag` placed just before </head> (or in front of the page when it has none). */
export function insertHeadTag(html, tag) {
  const i = html.search(/<\/head>/i);
  return i < 0 ? tag + html : html.slice(0, i) + tag + html.slice(i);
}
