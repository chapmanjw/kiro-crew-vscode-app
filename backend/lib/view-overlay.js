// Injected into the VS Code workbench page by the launcher's frame proxy
// (backend/lib/frameproxy.mjs injectOverlayScript), same origin, so the
// workbench CSP's `script-src 'self'` allows it. Plain script, no imports.
//
// It finds the "Kiro Crew" webview view the bridge extension contributes to
// VS Code's secondary side bar and tells the dashboard page (window.parent)
// where that view is, whether it shows and has focus, and whether any VS Code
// overlay (quick input, menus, dialogs, notifications, hovers, a drag) covers
// it. The page draws Kiro Crew's real ChatPanel over that rectangle and hides
// it whenever VS Code draws something on top.
//
// How the view is found (VS Code 1.14x DOM): a webview view's iframe is not
// inside its pane. It lives in an overlay at the workbench root
// (overlayWebview.ts: `.webview-overlay-content`), positioned over the pane
// body with CSS anchor positioning (base/browser/overlayLayoutElement.ts), and
// its src names the extension and purpose (webviewElement.ts:456-479:
// `extensionId=kiro-crew.kiro-crew-bridge&purpose=webviewView`). The anchor is
// the element whose inline `anchor-name` matches the overlay's
// `position-anchor`; when found, its box is the view's box, else the iframe's.
//
// Event driven: ResizeObserver on the anchor, the iframe and the document,
// MutationObserver on the workbench, window resize, focus and drag events.
// Each trigger asks for at most one measurement in the next animation frame,
// and a report is posted only when it changed. No timer loop.
//
// Messages (all JSON-safe objects):
//   frame -> parent  {type:'kc-view-ready'}                         targetOrigin '*', no data
//   parent -> frame  {type:'kc-view-hello', nonce}                  accepted only from window.parent
//   frame -> parent  {type:'kc-view', nonce, view, blocked, ...}     targetOrigin = the hello's origin
//   parent -> frame  {type:'kc-view-key', nonce, key}               a shortcut pressed in the overlay
//   parent -> frame  {type:'kc-view-focus', nonce}                  give keyboard focus back to VS Code
(function () {
  'use strict';
  if (window.__kcViewOverlay || window.parent === window) return;
  var EXT = 'kiro-crew.kiro-crew-bridge';
  var OVERLAYS = [
    ['quickInput', '.quick-input-widget'],
    ['contextView', '.context-view'],
    ['dialog', '.monaco-dialog-modal-block'],
    ['dialog', '.monaco-dialog-box'],
    ['notification', '.notifications-toasts.visible .notification-toast-container'],
    ['notificationCenter', '.notifications-center.visible'],
    ['hover', '.workbench-hover'],
    ['hover', '.monaco-hover:not(.hidden)'],
    ['menu', '.monaco-menu-container'],
  ];
  var st = {
    parentOrigin: null,
    nonce: null,
    last: '',
    raf: 0,
    seq: 0,
    dragging: false,
    reports: 0,
    measures: 0,
    observed: { anchor: null, iframe: null },
  };
  window.__kcViewOverlay = st;

  function findWebview() {
    var frames = document.querySelectorAll('iframe.webview');
    for (var i = 0; i < frames.length; i++) {
      var src = frames[i].getAttribute('src') || '';
      try {
        var u = new URL(src, location.href);
        if (String(u.searchParams.get('extensionId') || '').toLowerCase() === EXT && u.searchParams.get('purpose') === 'webviewView') return frames[i];
      } catch (e) {
        /* not a URL */
      }
    }
    return null;
  }

  function findAnchor(content) {
    if (!content) return null;
    var name = content.style.getPropertyValue('position-anchor');
    if (!name) return null;
    var els = document.querySelectorAll('[style*="anchor-name"]');
    for (var i = 0; i < els.length; i++) {
      if (els[i].style.getPropertyValue('anchor-name') === name) return els[i];
    }
    return null;
  }

  function shows(el) {
    if (!el || !el.isConnected) return false;
    var cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function intersects(a, b) {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  }

  function round(n) {
    return Math.round(n * 100) / 100;
  }

  function measure() {
    st.raf = 0;
    st.measures++;
    var iframe = findWebview();
    var content = iframe ? iframe.parentElement : null;
    var root = content ? content.parentElement : null;
    var anchor = findAnchor(content);
    observe(anchor, iframe);
    var view = { found: !!iframe, visible: false, rect: null, location: 'none', focused: false };
    var box = null;
    if (iframe && iframe.isConnected) {
      var useAnchor = anchor && anchor.isConnected && anchor.getClientRects().length > 0;
      var r = (useAnchor ? anchor : iframe).getBoundingClientRect();
      box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      // The overlay root clips the content to the anchor's scroll container.
      if (root && root.style.clipPath === 'content-box') {
        var c = root.getBoundingClientRect();
        box = { left: Math.max(box.left, c.left), top: Math.max(box.top, c.top), right: Math.min(box.right, c.right), bottom: Math.min(box.bottom, c.bottom) };
      }
      var part = anchor && anchor.closest('.part');
      view.location = part
        ? part.classList.contains('auxiliarybar') ? 'auxiliarybar' : part.classList.contains('sidebar') ? 'sidebar' : part.classList.contains('panel') ? 'panel' : part.classList.contains('editor') ? 'editor' : 'other'
        : 'unknown';
      var cs = content ? getComputedStyle(content) : null;
      var rootShown = !root || getComputedStyle(root).display !== 'none';
      view.visible = !!cs && cs.visibility !== 'hidden' && cs.display !== 'none' && rootShown && (!anchor || anchor.getClientRects().length > 0) &&
        box.right - box.left > 1 && box.bottom - box.top > 1;
      var active = document.activeElement;
      view.focused = document.hasFocus() && (active === iframe || (!!anchor && !!active && anchor.contains(active)));
      if (view.visible) view.rect = { x: round(box.left), y: round(box.top), width: round(box.right - box.left), height: round(box.bottom - box.top) };
    }
    var blocked = [];
    if (view.visible) {
      for (var i = 0; i < OVERLAYS.length; i++) {
        var els = document.querySelectorAll(OVERLAYS[i][1]);
        for (var j = 0; j < els.length; j++) {
          var el = els[j];
          if (iframe && (el.contains(iframe) || iframe.contains(el))) continue;
          if (OVERLAYS[i][0] === 'contextView' && !el.firstElementChild) continue;
          if (shows(el) && intersects(el.getBoundingClientRect(), box)) {
            if (blocked.indexOf(OVERLAYS[i][0]) < 0) blocked.push(OVERLAYS[i][0]);
            break;
          }
        }
      }
    }
    var report = {
      type: 'kc-view',
      view: view,
      blocked: blocked,
      dragging: st.dragging,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      hidden: document.visibilityState === 'hidden',
    };
    var text = JSON.stringify(report);
    if (text === st.last) return;
    st.last = text;
    send(report);
  }

  function send(report) {
    if (!st.parentOrigin || !st.nonce) return;
    st.seq++;
    st.reports++;
    report.nonce = st.nonce;
    report.seq = st.seq;
    window.parent.postMessage(report, st.parentOrigin);
  }

  function schedule() {
    if (!st.raf) st.raf = requestAnimationFrame(measure);
  }

  var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  function observe(anchor, iframe) {
    if (!ro) return;
    if (st.observed.anchor !== anchor) {
      if (st.observed.anchor) ro.unobserve(st.observed.anchor);
      if (anchor) ro.observe(anchor);
      st.observed.anchor = anchor;
    }
    if (st.observed.iframe !== iframe) {
      if (st.observed.iframe) ro.unobserve(st.observed.iframe);
      if (iframe) ro.observe(iframe);
      st.observed.iframe = iframe;
    }
  }

  function start() {
    if (ro) ro.observe(document.documentElement);
    // Class and style changes are how VS Code opens and closes its overlays,
    // shows and hides parts and moves the webview overlay.
    // Text rendering inside editors and terminals (lines, cursors, the
    // terminal's rows) changes on every keystroke and never moves a view, so
    // those records are skipped.
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var t = records[i].target;
        var el = t.nodeType === 1 ? t : t.parentElement;
        if (el && el.closest && el.closest('.view-lines, .view-overlays, .cursors-layer, .margin-view-overlays, .xterm-rows, .xterm-helpers')) continue;
        schedule();
        return;
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'aria-hidden'] });
    window.addEventListener('resize', schedule);
    window.addEventListener('focus', schedule);
    window.addEventListener('blur', schedule);
    document.addEventListener('focusin', schedule, true);
    document.addEventListener('focusout', schedule, true);
    document.addEventListener('visibilitychange', schedule);
    // A drag (a view, an editor tab, a file from outside) shows drop targets
    // anywhere, including over the view.
    var dragOn = function () {
      if (!st.dragging) {
        st.dragging = true;
        schedule();
      }
    };
    var dragOff = function () {
      if (st.dragging) {
        st.dragging = false;
        schedule();
      }
    };
    document.addEventListener('dragstart', dragOn, true);
    document.addEventListener('dragenter', dragOn, true);
    document.addEventListener('dragend', dragOff, true);
    document.addEventListener('drop', dragOff, true);
    document.addEventListener('dragleave', function (e) {
      if (!e.relatedTarget && (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight)) dragOff();
    }, true);
    // No pointer events fire during a native drag, so the first one after
    // means it is over even if no dragend reached this document.
    document.addEventListener('pointermove', function () {
      if (st.dragging) dragOff();
    }, true);
    schedule();
  }

  function keyCodeOf(k) {
    if (typeof k.keyCode === 'number' && k.keyCode > 0) return k.keyCode;
    return 0;
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var d = e.data;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
    if (d.type === 'kc-view-hello') {
      if (typeof d.nonce !== 'string' || d.nonce.length < 16 || d.nonce.length > 128) return;
      st.parentOrigin = e.origin;
      st.nonce = d.nonce;
      st.last = '';
      schedule();
      return;
    }
    if (!st.nonce || d.nonce !== st.nonce || e.origin !== st.parentOrigin) return;
    if (d.type === 'kc-view-key' && d.key && typeof d.key === 'object') {
      var k = d.key;
      var init = {
        key: String(k.key || ''), code: String(k.code || ''), ctrlKey: !!k.ctrlKey, shiftKey: !!k.shiftKey, altKey: !!k.altKey, metaKey: !!k.metaKey,
        repeat: false, bubbles: true, cancelable: true, composed: true,
      };
      var target = document.activeElement && document.activeElement !== document.body && document.activeElement.tagName !== 'IFRAME'
        ? document.activeElement
        : document.querySelector('.monaco-workbench') || document.body;
      try {
        window.focus();
      } catch (err) {
        /* not allowed */
      }
      var kc = keyCodeOf(k);
      ['keydown', 'keyup'].forEach(function (type) {
        var ev = new KeyboardEvent(type, init);
        // VS Code reads keyCode (StandardKeyboardEvent); a constructed event has 0.
        if (kc) {
          Object.defineProperty(ev, 'keyCode', { get: function () { return kc; } });
          Object.defineProperty(ev, 'which', { get: function () { return kc; } });
        }
        target.dispatchEvent(ev);
      });
      return;
    }
    if (d.type === 'kc-view-focus') {
      try {
        window.focus();
      } catch (err) {
        /* not allowed */
      }
      var wb = document.querySelector('.monaco-workbench');
      if (wb && typeof wb.focus === 'function' && !wb.contains(document.activeElement)) wb.focus();
    }
  });

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
  // Say we are here; the page answers with its hello. No data in it.
  window.parent.postMessage({ type: 'kc-view-ready' }, '*');
})();
