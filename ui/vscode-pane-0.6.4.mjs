// vscode-pane UI page (plain ESM, no build step). The dashboard imports this
// module into its own React tree; 'react', 'react-dom' and '@kirocrew/app-sdk'
// resolve through the host's import map. The file name carries the version so
// Electron's code cache cannot pin an old copy after an Update.
//
// Tabs. The page shows VS Code in tabs, one VS Code window each, all served by
// the one VS Code server. The launcher keeps the list (backend/lib/tabs.mjs):
// a tab opened from a chat's VS Code chip (`?session=<key>&folder=<cwd>`) is
// that chat's tab, and the chip brings the same tab back later; a tab opened
// with New tab, a `?folder=` link or the file menus shows the session list in
// its Kiro Crew view. Only tabs the user has looked at since the page loaded
// have a window; the others load when they are first shown.
//
// The VS Code iframes do not live in the React tree. The dashboard unmounts an
// app page whenever the user goes to another route (App.tsx renders one
// <Route path="/apps/:name"> element), and an iframe that is removed from the
// document is destroyed, so VS Code started over on every return. The frames
// are therefore kept in one host element attached to document.body, placed
// over the page's placeholder while the page is mounted and hidden (never
// removed) while it is not. Inside it, the front tab's frame shows and the
// others stay loaded but hidden, so switching tabs reloads nothing.
//
// The Kiro Crew chat lives in VS Code itself: the bridge's "Kiro Crew" tab in
// VS Code's secondary side bar frames Kiro Crew's own dashboard through the
// launcher's tunnel (backend/lib/kcproxy.mjs). That view asks this page which
// of its tabs it is in (a postMessage up the frame chain, answered below), and
// the launcher tells it what that tab shows. This page also signs the tunnel
// in: it runs inside the signed-in dashboard, so it asks the dashboard for a
// sign-in link (POST /api/auth/mobile-link, the "Connect your phone" mint) and
// hands it to the launcher (POST /api/kc/sign-in), once when the page opens and
// again whenever the tab's Connect button asks.
import React, { useState, useEffect, useCallback, useRef, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import * as sdk from '@kirocrew/app-sdk';
import {
  API,
  THEME_VARS,
  buildThemePayload,
  resolveKind,
  intentFromSearch,
  describeSessionError,
  tabFrameKey,
  frameUrlFor,
  tabWorkbenchUrl,
  framePlacement,
  probeUrl,
  webOriginAdvice,
  updateButton,
  updateBanner,
  serverStatusLine,
  sessionTitles,
  tabLabels,
  tabTooltip,
  baseName,
  CARD_MARGIN,
  BAR_HEIGHT,
} from './vscode-pane-core-0.6.4.mjs';

const { useAppApi, useTheme } = sdk;
// The dashboard's session titles label the tabs opened from chats, when the
// host offers the hook and admits this app to it; otherwise tabs show folder names.
const useHostSessionsIfAny = typeof sdk.useHostSessions === 'function' ? sdk.useHostSessions : () => null;

const h = React.createElement;
const FOLDER_KEY = 'kc:vscode-pane:folder';
// Card geometry of the Kiro Crew Sessions panel (website/src/components/listShell.ts
// LIST_SHELL_CLS: `rounded-xl` = --radius-xl, 1px --border, --bg-elevated,
// --shadow-sm). Its placement in <main> is CARD_MARGIN (see the core module).
const RADIUS_FALLBACK = 16;

// useAppApi throws AppApiError on non-2xx in 0.14 and resolved null in older
// hosts; fold both into one thrown error.
async function call(promise) {
  const r = await promise;
  if (r === null || r === undefined) throw new Error('request failed');
  return r;
}

function errText(e) {
  if (!e) return '';
  const body = typeof e.body === 'string' ? e.body : '';
  try {
    const parsed = JSON.parse(body);
    if (parsed && parsed.error) return parsed.error;
  } catch {
    /* not JSON */
  }
  return e.message || String(e);
}

// ---------------------------------------------------------------------------
// Styles. Everything reads the dashboard's own CSS variables, with the default
// dark palette as the fallback for a host that does not define them.
// ---------------------------------------------------------------------------

const STYLE_ID = 'vscode-pane-style-0-6-4';
// Each colour is the dashboard's variable when it is set. When it is not, the
// fallback follows the dashboard's kind (data-vscp-kind), using VS Code's stock
// Default Dark / Default Light colours, the same base the backend falls back to
// when it gets {kind} without vars.
const CSS = `
.vscp-themed{--vscp-bg:var(--bg,#1f1f1f);--vscp-elev:var(--bg-elevated,#181818);--vscp-hover:var(--bg-hover,#2b2b2b);
  --vscp-text:var(--text,#cccccc);--vscp-muted:var(--muted,#9d9d9d);--vscp-border:var(--border,#2b2b2b);
  --vscp-border-strong:var(--border-strong,#3c3c3c);--vscp-accent:var(--accent,#0078d4);--vscp-accent-fg:var(--accent-fg,#ffffff);
  --vscp-accent-hover:var(--accent-hover,#026ec1);--vscp-ring:var(--ring,#0078d4);--vscp-ok:var(--ok,#89d185);
  --vscp-warn:var(--warn,#cca700);--vscp-danger:var(--danger,#f85149);--vscp-shadow:var(--shadow-sm,none)}
.vscp-themed[data-vscp-kind="light"]{--vscp-bg:var(--bg,#ffffff);--vscp-elev:var(--bg-elevated,#f8f8f8);--vscp-hover:var(--bg-hover,#e8e8e8);
  --vscp-text:var(--text,#3b3b3b);--vscp-muted:var(--muted,#6e6e6e);--vscp-border:var(--border,#e5e5e5);
  --vscp-border-strong:var(--border-strong,#cecece);--vscp-accent:var(--accent,#005fb8);--vscp-accent-fg:var(--accent-fg,#ffffff);
  --vscp-accent-hover:var(--accent-hover,#0258a8);--vscp-ring:var(--ring,#005fb8);--vscp-ok:var(--ok,#388a34);
  --vscp-warn:var(--warn,#bf8803);--vscp-danger:var(--danger,#e51400)}
.vscp-card{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;box-sizing:border-box;
  margin:${CARD_MARGIN.top}px ${CARD_MARGIN.right}px ${CARD_MARGIN.bottom}px ${CARD_MARGIN.left}px;background:var(--vscp-elev);color:var(--vscp-text);
  border:1px solid var(--vscp-border);border-radius:var(--radius-xl,${RADIUS_FALLBACK}px);box-shadow:var(--vscp-shadow);
  font-family:var(--font-body,system-ui,sans-serif)}
.vscp-bar{display:flex;flex-wrap:nowrap;align-items:center;gap:4px;height:${BAR_HEIGHT}px;min-height:${BAR_HEIGHT}px;padding:0 8px 0 8px;
  box-sizing:border-box;border-bottom:1px solid var(--vscp-border);font-size:12px;overflow:hidden;white-space:nowrap}
.vscp-group{display:flex;align-items:center;gap:4px;min-width:0;flex:none}
.vscp-muted{color:var(--vscp-muted)}
.vscp-input{font:inherit;font-size:12px;height:26px;box-sizing:border-box;padding:0 6px;border-radius:var(--radius-sm,6px);min-width:0;
  border:1px solid var(--vscp-border);background:var(--vscp-bg);color:var(--vscp-text);outline:none}
.vscp-input:focus{border-color:var(--vscp-accent);box-shadow:0 0 0 1px var(--vscp-ring)}
.vscp-btn{font:inherit;font-size:12px;height:26px;box-sizing:border-box;padding:0 10px;border-radius:var(--radius-sm,6px);cursor:pointer;
  border:1px solid var(--vscp-border);background:transparent;color:var(--vscp-text);white-space:nowrap}
.vscp-btn:hover{background:var(--vscp-hover);border-color:var(--vscp-border-strong)}
.vscp-btn:focus-visible{outline:2px solid var(--vscp-ring);outline-offset:1px}
.vscp-btn-primary{background:var(--vscp-accent);color:var(--vscp-accent-fg);border-color:transparent}
.vscp-btn-primary:hover{background:var(--vscp-accent-hover);border-color:transparent}
.vscp-dot{width:8px;height:8px;border-radius:4px;display:inline-block;flex:none}
.vscp-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.vscp-tabs{display:flex;align-items:center;gap:2px;min-width:0;flex:0 1 auto;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
.vscp-tabs::-webkit-scrollbar{display:none}
.vscp-tab{display:flex;align-items:center;flex:0 1 auto;min-width:84px;max-width:220px;height:30px;box-sizing:border-box;
  border-radius:var(--radius-sm,6px);border:1px solid transparent;color:var(--vscp-muted)}
.vscp-tab:hover{background:var(--vscp-hover);color:var(--vscp-text)}
.vscp-tab[data-active="true"]{background:var(--vscp-bg);border-color:var(--vscp-border-strong);color:var(--vscp-text)}
.vscp-tab-main{display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 auto;height:100%;padding:0 2px 0 8px;border:0;
  border-radius:var(--radius-sm,6px);background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;text-align:left}
.vscp-tab-close{display:grid;place-items:center;flex:none;width:20px;height:20px;margin:0 4px 0 2px;padding:0;border-radius:4px;border:0;
  background:transparent;color:inherit;cursor:pointer;opacity:0}
.vscp-tab:hover .vscp-tab-close,.vscp-tab[data-active="true"] .vscp-tab-close,.vscp-tab-close:focus-visible{opacity:.75}
.vscp-tab-close:hover{background:var(--vscp-hover);opacity:1}
.vscp-icon-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;min-width:28px;height:28px;padding:0 6px;box-sizing:border-box;
  border-radius:var(--radius-sm,6px);border:1px solid transparent;background:transparent;color:var(--vscp-muted);cursor:pointer;position:relative;font:inherit}
.vscp-icon-btn:hover,.vscp-icon-btn[aria-expanded="true"]{background:var(--vscp-hover);color:var(--vscp-text)}
.vscp-tab-main:focus-visible,.vscp-tab-close:focus-visible,.vscp-icon-btn:focus-visible{outline:2px solid var(--vscp-ring);outline-offset:-2px}
.vscp-spacer{flex:1 1 0;min-width:4px}
.vscp-badge{position:absolute;top:3px;right:3px;width:7px;height:7px;border-radius:4px;background:var(--vscp-accent)}
.vscp-body{position:relative;flex:1 1 auto;min-height:0;min-width:0;background:var(--vscp-bg)}
.vscp-overlay{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:24px;font-size:13px}
.vscp-frame-host{background:var(--vscp-bg);color-scheme:dark}
.vscp-frame-host[data-vscp-kind="light"]{color-scheme:light}
/* The workbench is invisible until its page has loaded: the frame's own canvas is opaque white in a cross-origin
   frame whose colour scheme differs from the dashboard's, and the themed host shows through instead. */
.vscp-frame-host iframe{background:var(--vscp-bg)}
.vscp-frame-host iframe[data-ready="false"]{opacity:0}
.vscp-note{padding:6px 12px;font-size:12px;line-height:1.4;border-bottom:1px solid var(--vscp-border);color:var(--vscp-text);
  background:color-mix(in srgb,var(--vscp-warn) 14%,var(--vscp-elev));white-space:normal}
/* Menus and the new-tab panel sit on <body> above the VS Code frames (which are on <body> at z-index 2) and under
   the dashboard's own popovers and dialogs (z-50 and up). */
.vscp-pop{position:fixed;z-index:3;min-width:250px;max-width:min(440px,calc(100vw - 16px));max-height:calc(100vh - 16px);overflow:auto;box-sizing:border-box;
  padding:4px;border-radius:var(--radius-md,8px);border:1px solid var(--vscp-border-strong);background:var(--vscp-elev);color:var(--vscp-text);
  box-shadow:0 8px 24px rgba(0,0,0,.35);font-family:var(--font-body,system-ui,sans-serif);font-size:12px;white-space:nowrap}
.vscp-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;min-height:28px;padding:4px 8px;border:0;border-radius:4px;
  background:transparent;color:var(--vscp-text);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.vscp-item:hover:not(:disabled),.vscp-item:focus-visible{background:var(--vscp-hover);outline:none}
.vscp-item:disabled{color:var(--vscp-muted);cursor:default}
.vscp-info{display:flex;align-items:flex-start;gap:8px;padding:6px 8px;color:var(--vscp-muted);line-height:1.4;white-space:normal;word-break:break-word}
.vscp-info .vscp-dot{margin-top:4px}
.vscp-sep{height:1px;margin:4px 0;background:var(--vscp-border)}
.vscp-newtab{display:flex;align-items:center;gap:6px;padding:6px}
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

const STATUS_VAR = {
  ready: 'var(--vscp-ok)',
  starting: 'var(--vscp-warn)',
  provisioning: 'var(--vscp-warn)',
  error: 'var(--vscp-danger)',
  stopped: 'var(--vscp-muted)',
  idle: 'var(--vscp-muted)',
};

// Small line icons, drawn here so the page needs nothing from the host beyond React.
const ICON_PATHS = {
  plus: 'M8 3.5v9M3.5 8h9',
  close: 'M4.75 4.75l6.5 6.5M11.25 4.75l-6.5 6.5',
  folder: 'M2.5 4.25c0-.41.34-.75.75-.75h2.9l1.4 1.5h5.2c.41 0 .75.34.75.75v6c0 .41-.34.75-.75.75h-9.5a.75.75 0 0 1-.75-.75z',
  chat: 'M3 3.5h10c.55 0 1 .45 1 1v5.75c0 .55-.45 1-1 1H7.25L4.5 13.5v-2.25H3c-.55 0-1-.45-1-1V4.5c0-.55.45-1 1-1z',
};

function Icon({ name, size = 16 }) {
  const svg = { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false', style: { flex: 'none' } };
  if (name === 'more') {
    return h('svg', { ...svg, fill: 'currentColor' }, [3.5, 8, 12.5].map((x) => h('circle', { key: x, cx: x, cy: 8, r: 1.25 })));
  }
  return h('svg', { ...svg, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }, h('path', { d: ICON_PATHS[name] }));
}

// ---------------------------------------------------------------------------
// The detached frame host (one per document), with one frame per shown tab
// ---------------------------------------------------------------------------

const holder = {
  wrap: null,
  frames: new Map(), // tab id -> {iframe, key}
  shown: null, // the tab whose frame is showing
  loads: 0,
  placements: 0, // how often the frame was placed (the smoke checks it is not every frame)
  session: null, // last session seen, so a remount shows the live frame at once
  owner: null, // the mounted page's token, or null while unmounted
  kind: '', // last resolved dashboard kind, so a remount styles itself at once
  reach: null, // {instance, mode}: how this browser reaches the workbench, 'frame' (the frame port) or 'origin' (the app web origin)
  // Tunnel sign-in from this page (the smoke reads these).
  kcAutoEpoch: null, // the tunnel epoch the automatic attempt last ran for (once per page load and epoch)
  kcSeenConnect: null, // last connectRequests reading
  sessionSeq: 0, // GET /api/session requests sent
  sessionApplied: 0, // the newest one applied
  kcMints: [], // {via, ok, status} of each mint attempt
  nonces: new Map(), // tab id -> Reload count
  active: null, // the tab this page shows: the launcher's front tab, or the one just picked here
  activeSeq: 0, // bumps on every switch made here, so a poll sent before it does not undo it
  lastIntent: null, // the URL intent (?session=, ?folder=, ?tab=) last acted on
  migrated: false, // the first tab was opened on the folder 0.5 remembered
  /** The frame showing now (the smoke and the edge checks read it). */
  get iframe() {
    const f = this.shown ? this.frames.get(this.shown) : null;
    return f ? f.iframe : null;
  },
  get key() {
    const f = this.shown ? this.frames.get(this.shown) : null;
    return f ? f.key : null;
  },
};

function ensureHost() {
  if (holder.wrap && holder.wrap.isConnected) return holder;
  const wrap = document.createElement('div');
  wrap.setAttribute('data-vscode-pane-frame-host', '');
  wrap.className = 'vscp-themed vscp-frame-host';
  wrap.setAttribute('data-vscp-kind', holder.kind || 'dark');
  // Fixed on <body>, above the dashboard's <main> content but under its
  // popovers and dialogs (z-50 and up), and invisible until a page claims it.
  Object.assign(wrap.style, {
    position: 'fixed', left: '0px', top: '0px', width: '0px', height: '0px', zIndex: '2',
    visibility: 'hidden', pointerEvents: 'none', overflow: 'hidden',
  });
  document.body.appendChild(wrap);
  holder.wrap = wrap;
  // Frames of an earlier host went with it.
  holder.frames = new Map();
  holder.shown = null;
  return holder;
}

function frameFor(id) {
  ensureHost();
  let f = holder.frames.get(id);
  if (f) return f;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
  iframe.setAttribute('data-ready', 'false');
  iframe.setAttribute('data-tab', id);
  // Hidden until shown; `inherit` when shown, so the frame follows the host when it hides.
  Object.assign(iframe.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', border: '0', display: 'block', visibility: 'hidden' });
  iframe.title = 'VS Code (in the background)';
  iframe.tabIndex = -1;
  f = { iframe, key: null };
  // Reveal on the page's load event, but not for the initial about:blank (no key yet).
  iframe.addEventListener('load', () => {
    if (f.key !== null) iframe.setAttribute('data-ready', 'true');
  });
  holder.wrap.appendChild(iframe);
  holder.frames.set(id, f);
  return f;
}

function loadTabFrame(id, key, url) {
  const f = frameFor(id);
  if (f.key === key) return;
  f.key = key;
  holder.loads += 1;
  holder.wrap.setAttribute('data-loads', String(holder.loads));
  f.iframe.setAttribute('data-ready', 'false');
  f.iframe.src = url;
}

function showTabFrame(id) {
  if (!holder.wrap) return;
  holder.shown = holder.frames.has(id) ? id : null;
  for (const [tid, f] of holder.frames) {
    const on = tid === holder.shown;
    if (!on && document.activeElement === f.iframe) f.iframe.blur();
    const vis = on ? 'inherit' : 'hidden';
    if (f.iframe.style.visibility !== vis) f.iframe.style.visibility = vis;
    // Only the front frame is "VS Code" (and in the tab order); the others are hidden.
    f.iframe.title = on ? 'VS Code' : 'VS Code (in the background)';
    f.iframe.tabIndex = on ? 0 : -1;
    f.iframe.setAttribute('data-active', on ? 'true' : 'false');
  }
}

function dropTabFrame(id) {
  const f = holder.frames.get(id);
  holder.nonces.delete(id);
  if (!f) return;
  if (document.activeElement === f.iframe) f.iframe.blur();
  f.iframe.remove();
  holder.frames.delete(id);
  if (holder.shown === id) holder.shown = null;
}

function hideFrame() {
  if (!holder.wrap) return;
  // Keyboard focus must not stay in a frame nobody can see.
  for (const f of holder.frames.values()) if (document.activeElement === f.iframe) f.iframe.blur();
  if (holder.wrap.style.visibility !== 'hidden') holder.wrap.style.visibility = 'hidden';
  if (holder.wrap.style.pointerEvents !== 'none') holder.wrap.style.pointerEvents = 'none';
  if (holder.wrap.getAttribute('data-visible') !== 'false') holder.wrap.setAttribute('data-visible', 'false');
}

function placeFrame(p) {
  const s = holder.wrap.style;
  const set = (k, v) => {
    if (s[k] !== v) s[k] = v;
  };
  set('left', `${p.left}px`);
  set('top', `${p.top}px`);
  set('width', `${p.width}px`);
  set('height', `${p.height}px`);
  set('clipPath', p.clip);
  set('visibility', 'visible');
  set('pointerEvents', 'auto');
  if (holder.wrap.getAttribute('data-visible') !== 'true') holder.wrap.setAttribute('data-visible', 'true');
}

/** The tab whose frame holds window `w` (a webview, or the workbench itself), or null. Cross-origin `parent` reads are allowed. */
function tabOfWindow(w) {
  for (let i = 0; w && i < 8; i++) {
    for (const [id, f] of holder.frames) if (f.iframe.contentWindow === w) return id;
    let up = null;
    try {
      up = w.parent;
    } catch {
      return null;
    }
    if (!up || up === w) return null;
    w = up;
  }
  return null;
}

if (typeof window !== 'undefined') {
  // Test and debug hook: the smoke harness reads load counts from here.
  window.__vscodePane = holder;
  // "Which tab am I in?" from VS Code's Kiro Crew view (extension crewview.js) or
  // the remote viewers' chat overlay (backend/lib/overlay.mjs). Only a window
  // inside one of this page's frames gets an answer, and the answer is the tab id.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || d.vscodePane !== 'tab?' || typeof d.nonce !== 'string' || d.nonce.length > 80 || !e.source) return;
    const id = tabOfWindow(e.source);
    if (!id) return;
    try {
      e.source.postMessage({ vscodePane: 'tab', nonce: d.nonce, tab: id }, e.origin && e.origin !== 'null' ? e.origin : '*');
    } catch {
      /* the frame went away */
    }
  });
}

// ---------------------------------------------------------------------------
// Theme: read the dashboard's effective palette and send it to the backend
// ---------------------------------------------------------------------------

/** Resolve each token to a colour string the core parser understands. */
function readThemeRaw() {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const raw = {};
  try {
    if (!ctx) return raw;
    const declared = getComputedStyle(probe);
    for (const name of THEME_VARS) {
      if (!declared.getPropertyValue(name).trim()) continue;
      probe.style.color = '';
      probe.style.color = `var(${name})`;
      const computed = getComputedStyle(probe).color; // rgb(), rgba(), or color(srgb ...) for color-mix
      if (!computed) continue;
      // Paint it to read back sRGB bytes; this handles every syntax the browser knows.
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = computed;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      raw[name] = `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
    }
  } finally {
    probe.remove();
  }
  return raw;
}

/**
 * Always returns a body with `kind`. `vars` is present only when at least one
 * token resolved to a colour; a page that cannot read them sends `{kind}`,
 * and the backend then uses stock VS Code Default Dark or Light.
 */
function currentThemePayload(sdkMode) {
  const root = document.documentElement;
  const name = root.getAttribute('data-theme') || '';
  // The SDK's mode is the same attribute, defaulting to 'dark' when it is
  // absent, so it only counts when the attribute is really there.
  const hints = {
    sdkMode: root.hasAttribute('data-theme') ? sdkMode || '' : '',
    prefersDark: window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : undefined,
  };
  let raw = {};
  try {
    raw = readThemeRaw();
  } catch {
    raw = {};
  }
  try {
    return buildThemePayload(raw, name, hints);
  } catch {
    return { kind: resolveKind({ themeName: name, sdkMode: hints.sdkMode, prefersDark: hints.prefersDark }) };
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** The folder 0.5 remembered in this browser; the first tab opens on it. */
function readStoredFolder() {
  try {
    return window.localStorage.getItem(FOLDER_KEY) || '';
  } catch {
    return '';
  }
}

function forgetStoredFolder() {
  try {
    window.localStorage.removeItem(FOLDER_KEY);
  } catch {
    /* storage blocked */
  }
}

/** The router's key for this history entry ('' when the host's router keeps none): a new navigation, even to the same URL, gets a new one. */
function historyKey() {
  const st = window.history.state;
  return st && typeof st === 'object' ? String(st.key || st.idx || '') : '';
}

/** The page URL as an intent signature. */
function currentIntentSig() {
  return `${window.location.pathname}${window.location.search}|${historyKey()}`;
}

/**
 * The one-time setup that lets the dashboard mint links: dashboard.url set to
 * the dashboard's own origin. The dashboard cannot write it (the config PATCH
 * refuses URL-valued keys, handlers/config_all_settings.py TEXT_EDIT_PATHS),
 * so the page shows the CLI command (cli_parser_gateway.py:443) and never
 * changes config itself. The value takes effect after a restart
 * (config/sections_dashboard.py, restart=True).
 */
function dashboardUrlCommand() {
  return `kirocrew config set dashboard.url ${window.location.origin}`;
}

/**
 * Mint a sign-in link with the dashboard's own session and give it to the
 * launcher. The page is a module inside the dashboard document, so a plain
 * same-origin fetch carries the dashboard's HttpOnly session cookie; the
 * gateway refuses app tokens on this route (handlers/auth_mobile.py:83-88), so
 * it must be the user's session, not useAppApi. It answers 409
 * external_origin_unavailable until Settings has a dashboard URL
 * (auth_mobile.py:105-111); the tab then offers the paste field.
 */
async function mintAndSignIn(api, via) {
  let entry = { via, ok: false, status: 0 };
  try {
    const r = await fetch('/api/auth/mobile-link', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' });
    entry.status = r.status;
    const j = await r.json().catch(() => null);
    if (r.ok && j && typeof j.url === 'string') {
      const done = await call(api.post(`${API}/kc/sign-in`, { url: j.url, via }));
      entry.ok = !!done.ok;
      entry.error = done.error || null;
    } else {
      const code = (j && (j.code || j.error)) || `HTTP ${r.status}`;
      entry.code = String(code).slice(0, 60);
      entry.error = code === 'external_origin_unavailable'
        ? `This Kiro Crew has no dashboard URL, so it cannot mint a sign-in link (external_origin_unavailable). Run "${dashboardUrlCommand()}" and restart Kiro Crew; the tab then signs in by itself. Or paste a kirocrew token link into the tab.`
        : `the dashboard refused a sign-in link: ${code}`;
      await call(api.post(`${API}/kc/sign-in`, { error: entry.error, code: entry.code, via })).catch(() => {});
    }
  } catch (e) {
    entry.error = errText(e);
  }
  holder.kcMints.push(entry);
  return entry;
}

/**
 * A menu or panel on <body>, under its button. It closes on Escape (focus goes
 * back to the button), on a click elsewhere, and when focus moves into a VS
 * Code frame (a click in VS Code reaches this document only as a window blur).
 */
function Popover({ anchor, onClose, role, label, testid, kind, align = 'right', focusFirst = true, children }) {
  const ref = useRef(null);
  // Placed from the first render, so it is never hidden while the first item takes focus.
  const where = () => {
    const a = anchor.current;
    if (!a) return null;
    const r = a.getBoundingClientRect();
    const top = Math.round(r.bottom + 4);
    return align === 'right' ? { top, right: Math.max(8, Math.round(window.innerWidth - r.right)) } : { top, left: Math.max(8, Math.round(r.left)) };
  };
  const [pos, setPos] = useState(where);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const place = () => setPos(where());
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (focusFirst && ref.current) {
      const first = ref.current.querySelector('.vscp-item:not(:disabled)');
      if (first) first.focus();
    }
    const onDown = (e) => {
      if (ref.current && ref.current.contains(e.target)) return;
      if (anchor.current && anchor.current.contains(e.target)) return;
      closeRef.current(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current(true);
      }
    };
    const onBlur = () => setTimeout(() => {
      if (document.activeElement && document.activeElement.tagName === 'IFRAME') closeRef.current(false);
    }, 0);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onKeyDown = (e) => {
    if (role !== 'menu' || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const items = [...ref.current.querySelectorAll('.vscp-item:not(:disabled)')];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next].focus();
  };
  return createPortal(
    h('div', {
      ref, className: 'vscp-themed vscp-pop', 'data-vscp-kind': kind, role, 'aria-label': label, 'data-testid': testid, onKeyDown,
      style: pos || { top: 0, left: 0, visibility: 'hidden' },
    }, children),
    document.body,
  );
}

function menuItem(label, onClick, { disabled = false, testid } = {}) {
  return h('button', { key: testid || label, type: 'button', role: 'menuitem', className: 'vscp-item', disabled, onClick, 'data-testid': testid }, label);
}

export default function VsCodePane() {
  ensureStyle();
  // The host may hand a new client object per render; read it through a ref so
  // polling effects do not restart on every render.
  const apiNow = useAppApi();
  const apiRef = useRef(apiNow);
  apiRef.current = apiNow;
  const api = useMemo(() => ({
    get: (...a) => apiRef.current.get(...a),
    post: (...a) => apiRef.current.post(...a),
  }), []);
  const sdkTheme = useTheme();
  const hostSessions = useHostSessionsIfAny();
  const titles = useMemo(() => sessionTitles(hostSessions && hostSessions.sessions), [hostSessions && hostSessions.sessions]);
  const [session, setSession] = useState(holder.session);
  const [sessionError, setSessionError] = useState('');
  const [recent, setRecent] = useState([]);
  const [, setNonceTick] = useState(0);
  const [editor, setEditor] = useState(null);
  const [kind, setKind] = useState(holder.kind || 'dark');
  const rootRef = useRef(null);
  const placeholderRef = useRef(null);
  const menuBtnRef = useRef(null);
  const newTabBtnRef = useRef(null);
  const [flash, setFlash] = useState(null); // {text, tone}: a short-lived line under the toolbar
  const [updateNote, setUpdateNote] = useState('');
  const [kcBusy, setKcBusy] = useState(false);
  const [activeId, setActiveId] = useState(holder.active);
  const [menuOpen, setMenuOpen] = useState(false);
  const [newTabOpen, setNewTabOpen] = useState(false);
  const [folderInput, setFolderInput] = useState('');
  const [tabError, setTabError] = useState('');
  const [intentSig, setIntentSig] = useState(currentIntentSig);

  const say = useCallback((text, tone = 'status') => setFlash(text ? { text, tone, at: Date.now() } : null), []);
  useEffect(() => {
    if (!flash) return undefined;
    const t = setTimeout(() => setFlash(null), 6000);
    return () => clearTimeout(t);
  }, [flash]);

  // The tabs, as the launcher keeps them. An older launcher has no tabs: its one
  // workbench shows as a single tab that cannot be closed.
  const tabsInfo = session && session.tabs && Array.isArray(session.tabs.list) ? session.tabs : null;
  const tabList = tabsInfo ? tabsInfo.list : session && session.url ? [{ id: 'legacy', folder: session.folder || '', session: null, url: session.url }] : [];
  const tabIds = tabList.map((t) => t.id).join(',');
  const activeTab = tabList.find((t) => t.id === activeId) || (tabsInfo ? null : tabList[0] || null);
  const labels = useMemo(() => tabLabels(tabList, titles), [tabIds, titles, tabList.map((t) => `${t.folder}|${t.session || ''}`).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const adoptActive = useCallback((id) => {
    holder.active = id || null;
    setActiveId(holder.active);
  }, []);

  const applyTabs = useCallback((tabs) => {
    if (!tabs || !holder.session) return;
    holder.session = { ...holder.session, tabs };
    setSession(holder.session);
  }, []);

  // How this browser reaches the workbench. On the machine that runs the launcher
  // the frame port answers; for a dashboard reached through a Remote Crew tunnel
  // it does not (127.0.0.1 is the viewer's own machine), and the workbench is
  // loaded from the app's web origin on the dashboard's own port instead.
  const [reach, setReach] = useState(holder.reach);
  const reachInstance = session && session.instance;
  const reachReady = !!(session && session.ready && session.url);
  const reachProbe = probeUrl(session);
  useEffect(() => {
    if (!reachReady) return undefined;
    if (!reachProbe || window.location.protocol !== 'http:') {
      holder.reach = { instance: reachInstance, mode: 'frame' };
      setReach(holder.reach);
      return undefined;
    }
    if (holder.reach && holder.reach.instance === reachInstance) {
      setReach(holder.reach);
      return undefined;
    }
    let done = false;
    const probe = document.createElement('iframe');
    probe.setAttribute('aria-hidden', 'true');
    probe.tabIndex = -1;
    Object.assign(probe.style, { position: 'absolute', width: '0', height: '0', border: '0', visibility: 'hidden' });
    const finish = (mode) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      probe.remove();
      holder.reach = { instance: reachInstance, mode };
      setReach(holder.reach);
    };
    const onMessage = (e) => {
      if (e.source === probe.contentWindow && e.data && e.data.vscodePaneProbe === reachInstance) finish('frame');
    };
    const timer = setTimeout(() => finish('origin'), 2500);
    window.addEventListener('message', onMessage);
    probe.src = reachProbe;
    document.body.appendChild(probe);
    return () => {
      done = true;
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      probe.remove();
    };
  }, [reachReady, reachInstance, reachProbe]);
  // On the web origin the gateway must be willing to relay on the port this browser
  // reaches the dashboard on; ask the launcher (it sits beside the gateway) before loading.
  const reachMode = reach && reach.instance === reachInstance ? reach.mode : null;
  const viaOrigin = reachMode === 'origin';
  const originPort = window.location.port || '80';
  const [originCheck, setOriginCheck] = useState(null);
  const [originTry, setOriginTry] = useState(0);
  const [allowing, setAllowing] = useState(false);
  const [allowResult, setAllowResult] = useState(null);
  useEffect(() => {
    if (!viaOrigin) return undefined;
    let alive = true;
    call(api.get(`${API}/web-origin?port=${encodeURIComponent(originPort)}`)).then(
      (r) => { if (alive) setOriginCheck({ ...r, port: originPort }); },
      (e) => { if (alive) setOriginCheck({ state: 'error', port: originPort, error: errText(e) }); },
    );
    return () => { alive = false; };
  }, [viaOrigin, originPort, originTry, reachInstance]); // eslint-disable-line react-hooks/exhaustive-deps
  const originAdvice = viaOrigin && originCheck && originCheck.port === originPort ? webOriginAdvice(originCheck, originPort) : null;
  const originPending = viaOrigin && !(originCheck && originCheck.port === originPort);
  const allowPort = async () => {
    setAllowing(true);
    setAllowResult(null);
    try {
      const r = await call(api.post(`${API}/web-origin/allow-port`, { port: Number(originPort) }));
      setAllowResult({ ok: !!r.ok, file: r.file, changed: r.changed, error: r.error || null });
      setOriginTry((n) => n + 1);
    } catch (e) {
      setAllowResult({ ok: false, error: errText(e) });
    } finally {
      setAllowing(false);
    }
  };

  // The front tab's frame: its URL as this browser reaches it, and the identity of its load.
  const frameReady = reachReady && !!reachMode && !originAdvice && !originPending;
  const activeUrl = activeTab && frameReady ? frameUrlFor(tabWorkbenchUrl(activeTab.url, activeTab.id), session, reachMode, window.location) : null;
  const key = activeUrl
    ? tabFrameKey({ id: activeTab.id, nonce: holder.nonces.get(activeTab.id) || 0, instance: session.instance, generation: session.generation, mode: reachMode })
    : null;
  const ready = !!key;

  const loadSession = useCallback(async () => {
    // Overlapping polls must not let an older answer overwrite a newer one, and
    // a tab picked here after a poll was sent must not be undone by its answer.
    const seq = ++holder.sessionSeq;
    const switches = holder.activeSeq;
    try {
      const s = await call(api.get(`${API}/session`));
      if (seq < holder.sessionApplied) return;
      holder.sessionApplied = seq;
      holder.session = s;
      setSession(s);
      setSessionError('');
      if (s.tabs && holder.activeSeq === switches) adoptActive(s.tabs.active);
    } catch (e) {
      setSessionError(errText(e));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the session: every 1.5 s while VS Code starts, every 2 s once it is up
  // so a server restart (new generation) and tabs opened elsewhere are seen quickly.
  useEffect(() => {
    let alive = true;
    let timer;
    const tick = async () => {
      await loadSession();
      if (alive) timer = setTimeout(tick, ready ? 2000 : 1500);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [loadSession, ready]);

  // VS Code -> Kiro Crew: the front tab's active editor as its bridge extension reports it.
  const editorTab = activeTab && activeTab.id !== 'legacy' ? activeTab.id : '';
  useEffect(() => {
    if (!ready) return undefined;
    let alive = true;
    let timer;
    const tick = async () => {
      try {
        const st = await call(api.get(`${API}/state${editorTab ? `?tab=${encodeURIComponent(editorTab)}` : ''}`));
        if (alive) setEditor(st);
      } catch {
        /* keep the last value */
      }
      if (alive) timer = setTimeout(tick, 2000);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [ready, editorTab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    call(api.get('/api/recent-projects'))
      .then((r) => alive && Array.isArray(r.dirs) && setRecent(r.dirs.filter((d) => typeof d === 'string' && d).slice(0, 20)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Theme: send the dashboard palette on mount, on every theme change, and to
  // each new server generation (a restarted server starts from defaults).
  const lastTheme = useRef('');
  const sdkModeRef = useRef('');
  sdkModeRef.current = (sdkTheme && sdkTheme.mode) || '';
  const postTheme = useCallback((force) => {
    const payload = currentThemePayload(sdkModeRef.current);
    holder.kind = payload.kind;
    setKind(payload.kind);
    if (holder.wrap) holder.wrap.setAttribute('data-vscp-kind', payload.kind);
    const text = JSON.stringify(payload);
    if (!force && text === lastTheme.current) return;
    lastTheme.current = text;
    Promise.resolve()
      .then(() => api.post(`${API}/theme`, payload))
      .catch(() => {
        // Not fatal: an older backend has no theme route. Let the next change retry.
        lastTheme.current = '';
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    postTheme(true);
    let timer;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => postTheme(false), 120);
    };
    const mo = new MutationObserver(soon);
    const attributeFilter = ['data-theme', 'data-color-theme', 'style', 'class'];
    mo.observe(document.documentElement, { attributes: true, attributeFilter });
    mo.observe(document.body, { attributes: true, attributeFilter });
    // Theme packs and custom themes arrive as <style> elements in <head>.
    mo.observe(document.head, { childList: true, subtree: true, characterData: true });
    const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    if (mq && mq.addEventListener) mq.addEventListener('change', soon);
    return () => {
      clearTimeout(timer);
      mo.disconnect();
      if (mq && mq.removeEventListener) mq.removeEventListener('change', soon);
    };
  }, [postTheme]);

  useEffect(() => {
    postTheme(false);
  }, [sdkTheme && sdkTheme.mode, sdkTheme && sdkTheme.colorTheme, sdkTheme && sdkTheme.accent, postTheme]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tunnel sign-in: once per page load when it is not connected (a), and on
  // every Connect press in VS Code's Kiro Crew tab (b), which the launcher
  // counts in session.kc.connectRequests.
  const kcState = session && session.kc;
  const kcConnected = !!(kcState && kcState.connected);
  const kcAvailable = !!(kcState && kcState.available);
  const kcRequests = kcState && Number.isInteger(kcState.connectRequests) ? kcState.connectRequests : null;
  const signIn = useCallback(async (via) => {
    setKcBusy(true);
    try {
      await mintAndSignIn(api, via);
      await loadSession();
    } finally {
      setKcBusy(false);
    }
  }, [loadSession]); // eslint-disable-line react-hooks/exhaustive-deps
  // Automatic sign-in: at most once per page load and tunnel epoch (the epoch
  // moves when a session ends, say a 401 after 30 idle days), and never after
  // the user pressed Disconnect, which the launcher keeps until Connect or a
  // paste (V5 S-2, S-3).
  const kcEpoch = kcState && Number.isInteger(kcState.epoch) ? kcState.epoch : 0;
  const kcUserOff = !!(kcState && kcState.userDisconnected);
  useEffect(() => {
    if (!kcAvailable || holder.kcAutoEpoch === kcEpoch) return;
    holder.kcAutoEpoch = kcEpoch;
    if (!kcConnected && !kcUserOff) signIn('auto');
  }, [kcAvailable, kcConnected, kcUserOff, kcEpoch, signIn]);
  useEffect(() => {
    if (kcRequests === null) return;
    const seen = holder.kcSeenConnect;
    holder.kcSeenConnect = kcRequests;
    // The first reading is a baseline; a lower count is a restarted launcher.
    if (seen === null || kcRequests <= seen) return;
    // Even when the tunnel says connected: its session may be dead (V5 S-2).
    signIn('connect');
  }, [kcRequests, signIn]);
  const kcDisconnect = async () => {
    setKcBusy(true);
    try {
      await call(api.post(`${API}/kc/disconnect`, {}));
      await loadSession();
    } catch (e) {
      setSessionError(errText(e));
    } finally {
      setKcBusy(false);
    }
  };

  // The VS Code server's update check and update. Shown only for a build the app installed.
  const ownsServer = !!(session && session.server && session.server.owned);
  const up = session && session.update ? session.update : null;
  const button = updateButton(up);
  const banner = updateNote ? { tone: 'error', text: updateNote, install: null } : updateBanner(up);
  const updateBusy = !!(up && (up.phase === 'checking' || up.phase === 'downloading' || up.phase === 'restarting'));
  const updateAvailable = ownsServer && !!(up && up.phase === 'available');
  const doCheckUpdate = async () => {
    setUpdateNote('');
    try {
      await call(api.post(`${API}/server-update/check`, {}));
    } catch (e) {
      setUpdateNote(`Could not check: ${errText(e)}`);
    }
    await loadSession();
  };
  const doInstallUpdate = async (commit) => {
    setUpdateNote('');
    try {
      await call(api.post(`${API}/server-update/install`, { commit }));
    } catch (e) {
      setUpdateNote(`Could not update: ${errText(e)}`);
    }
    await loadSession();
  };

  // ------------------------------------------------------------- tabs

  const selectTab = useCallback((id) => {
    holder.activeSeq += 1;
    adoptActive(id);
    setTabError('');
    if (id === 'legacy') return;
    call(api.post(`${API}/tabs/activate`, { id }))
      .then((r) => applyTabs(r.tabs), () => {})
      .finally(() => loadSession());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openTab = useCallback(async (body) => {
    setTabError('');
    try {
      const r = await call(api.post(`${API}/tabs/open`, body));
      applyTabs(r.tabs);
      if (r.tab) {
        holder.activeSeq += 1;
        adoptActive(r.tab.id);
      }
      if (r.note) say(r.note);
      return r.tab || null;
    } catch (e) {
      setTabError(errText(e));
      return null;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const closeTab = useCallback(async (id) => {
    setTabError('');
    try {
      const r = await call(api.post(`${API}/tabs/close`, { id }));
      dropTabFrame(id);
      applyTabs(r.tabs);
      if (r.tabs) {
        holder.activeSeq += 1;
        adoptActive(r.tabs.active);
      }
    } catch (e) {
      setTabError(errText(e));
      say(`Could not close the tab: ${errText(e)}`, 'error');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The route can change under a mounted page (another chat's VS Code button,
  // a file menu's "Open in VS Code"): follow a new `?session=`, `?folder=` or `?tab=`.
  useEffect(() => {
    const check = () => setIntentSig(currentIntentSig());
    const timer = setInterval(check, 400);
    window.addEventListener('popstate', check);
    return () => {
      clearInterval(timer);
      window.removeEventListener('popstate', check);
    };
  }, []);

  const tabsKnown = !!tabsInfo;
  // An intent is acted on once per navigation: with the router's history key,
  // a remount on the same history entry (or Back to it) leaves the tabs alone;
  // without one, each mount of the page is a navigation.
  const mountId = useRef(Math.random().toString(36).slice(2)).current;
  const intentMark = intentSig.endsWith('|') ? `${mountId}|${intentSig}` : intentSig;
  useEffect(() => {
    if (!tabsKnown) return;
    const intent = intentFromSearch(window.location.search);
    if (!intent) {
      // A first run (no tab file yet): the first tab opens on the folder 0.5 used last.
      if (holder.session && holder.session.tabs && holder.session.tabs.fresh && !holder.migrated) {
        holder.migrated = true;
        const folder = readStoredFolder();
        openTab({ folder: folder || null, reuse: true }).then((t) => {
          if (t) forgetStoredFolder();
          else if (folder) openTab({ reuse: true });
        });
      }
      return;
    }
    if (holder.lastIntent === intentMark) return;
    const list = holder.session.tabs.list;
    // A tab named by a link shows once the launcher lists it.
    if (intent.tab && !intent.session && !intent.folder && !list.some((t) => t.id === intent.tab)) return;
    holder.lastIntent = intentMark;
    if (intent.tab && list.some((t) => t.id === intent.tab)) selectTab(intent.tab);
    else openTab({ folder: intent.folder || null, session: intent.session || null, reuse: true });
  }, [intentMark, tabsKnown, tabIds]); // eslint-disable-line react-hooks/exhaustive-deps

  // A tab closed here or elsewhere takes its frame with it.
  useEffect(() => {
    if (!tabsKnown) return;
    const ids = new Set(tabList.map((t) => t.id));
    for (const id of [...holder.frames.keys()]) if (!ids.has(id)) dropTabFrame(id);
  }, [tabIds, tabsKnown]); // eslint-disable-line react-hooks/exhaustive-deps

  const revealCrew = async () => {
    try {
      const r = await call(api.post(`${API}/crew/view`, { action: 'reveal', ...(editorTab ? { tab: editorTab } : {}) }));
      if (!r.ok) say(r.timeout ? 'VS Code did not answer' : `Could not open the Kiro Crew tab: ${r.error || 'unknown error'}`, 'error');
    } catch (e) {
      say(`Could not open the Kiro Crew tab: ${errText(e)}`, 'error');
    }
  };

  const generation = session && session.generation;
  const instance = session && session.instance;
  useEffect(() => {
    if (ready) postTheme(true);
  }, [ready, generation, instance, postTheme]);

  // Load the front tab into its frame only when its identity changes, so
  // polling, remounts and route changes never reload it, and show it.
  const activeKeyId = activeTab ? activeTab.id : null;
  useEffect(() => {
    if (key && activeUrl && activeKeyId) loadTabFrame(activeKeyId, key, activeUrl);
    if (holder.wrap) showTabFrame(activeKeyId);
  }, [key, activeKeyId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Claim the frames while mounted; place the host over the placeholder and size the
  // card to the space left in the dashboard's <main>. Placement runs on
  // change, not every frame: a ResizeObserver on the card, its frame slot,
  // <main> and the document element (window resize, side panels opening, zoom,
  // a layout shift that resizes <main>), window resize, capture-phase scroll,
  // and a 500 ms fallback for moves nothing reports. Each trigger asks for at
  // most one placement in the next animation frame.
  const showFrame = ready && !!key;
  const showRef = useRef(showFrame);
  showRef.current = showFrame;
  const scheduleRef = useRef(() => {});
  useLayoutEffect(() => {
    const token = {};
    holder.owner = token;
    let raf = 0;
    let lastHeight = '';
    const place = () => {
      raf = 0;
      holder.placements += 1;
      const root = rootRef.current;
      const ph = placeholderRef.current;
      if (!root || !ph) return;
      const main = root.closest('main') || document.getElementById('main-content');
      const vb = { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
      const mb = main ? main.getBoundingClientRect() : vb;
      const bounds = {
        top: Math.max(vb.top, mb.top),
        left: Math.max(vb.left, mb.left),
        width: Math.min(vb.left + vb.width, mb.left + mb.width) - Math.max(vb.left, mb.left),
        height: Math.min(vb.top + vb.height, mb.top + mb.height) - Math.max(vb.top, mb.top),
      };
      const rr = root.getBoundingClientRect();
      // Fill the rest of <main> below the card's top, keeping the bottom inset.
      const want = `${Math.max(240, Math.floor(bounds.top + bounds.height - rr.top - CARD_MARGIN.bottom))}px`;
      if (want !== lastHeight) {
        root.style.height = want;
        lastHeight = want;
      }
      if (!showRef.current || !holder.wrap || holder.owner !== token) {
        hideFrame();
        return;
      }
      const radius = parseFloat(getComputedStyle(root).borderBottomLeftRadius) || 0;
      const inner = Math.max(0, radius - 1);
      // The card's bottom border sits just below the placeholder. The frame runs
      // down over it, so the status bar meets the card's edge with no line under it.
      const pr = ph.getBoundingClientRect();
      const bottomBorder = parseFloat(getComputedStyle(root).borderBottomWidth) || 0;
      const p = framePlacement({ top: pr.top, left: pr.left, width: pr.width, height: pr.height + bottomBorder }, bounds, [0, 0, inner, inner]);
      if (p) placeFrame(p);
      else hideFrame();
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(place);
    };
    scheduleRef.current = schedule;
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    if (ro) {
      for (const el of [rootRef.current, placeholderRef.current, document.documentElement]) if (el) ro.observe(el);
      const main = rootRef.current && (rootRef.current.closest('main') || document.getElementById('main-content'));
      if (main) ro.observe(main);
    }
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    const fallback = setInterval(schedule, 500);
    place();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      clearInterval(fallback);
      scheduleRef.current = () => {};
      if (holder.owner === token) {
        holder.owner = null;
        hideFrame();
      }
    };
  }, []);
  // Showing or hiding the frame (ready, a new frame key, the kind changing the
  // card's colours) is a change no observer sees.
  useLayoutEffect(() => {
    scheduleRef.current();
  }, [showFrame, key, kind]);

  const reloadActive = () => {
    if (!activeTab) return;
    holder.nonces.set(activeTab.id, (holder.nonces.get(activeTab.id) || 0) + 1);
    setNonceTick((n) => n + 1);
  };

  const doInstall = async () => {
    try {
      await call(api.post(`${API}/install-server`, {}));
      setSession((s) => (s ? { ...s, status: 'provisioning', message: 'Looking up VS Code server download', error: null, action: null } : s));
    } catch (e) {
      setSessionError(errText(e));
    }
  };

  const doRestart = async () => {
    try {
      await call(api.post(`${API}/restart`, {}));
      setSession((s) => (s ? { ...s, ready: false, status: 'starting', message: 'Restarting VS Code server' } : s));
    } catch (e) {
      setSessionError(errText(e));
    }
  };

  const openFolderTab = async (value) => {
    const tab = await openTab({ folder: String(value || '').trim() || null, reuse: false });
    if (tab) {
      setNewTabOpen(false);
      setFolderInput('');
    }
  };

  const status = session ? session.status : sessionError ? 'error' : 'idle';
  const sessionProblem = sessionError ? describeSessionError(sessionError) : null;
  const statusText = serverStatusLine(session, sessionProblem);

  const active = editor && editor.activeEditor;
  const activeText = active
    ? `${active.path}${active.selection ? `:${active.selection.startLine}:${active.selection.startColumn}` : ''}`
    : '';

  const closeMenu = useCallback((refocus) => {
    setMenuOpen(false);
    if (refocus && menuBtnRef.current) menuBtnRef.current.focus();
  }, []);
  const closeNewTab = useCallback((refocus) => {
    setNewTabOpen(false);
    if (refocus && newTabBtnRef.current) newTabBtnRef.current.focus();
  }, []);
  const act = (fn) => () => {
    setMenuOpen(false);
    fn();
  };

  // Arrow keys move between tabs.
  const onTabsKey = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const items = [...e.currentTarget.querySelectorAll('[role="tab"]')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    items[(i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length].focus();
  };

  const toolbar = h(
    'div',
    { className: 'vscp-bar', role: 'toolbar', 'aria-label': 'VS Code tabs and controls' },
    h('div', { className: 'vscp-tabs', role: 'tablist', 'aria-label': 'VS Code tabs', 'data-testid': 'vscode-pane-tabs', onKeyDown: onTabsKey },
      tabList.map((t) => {
        const on = !!activeTab && t.id === activeTab.id;
        const label = labels[t.id] || baseName(t.folder);
        return h('div', { key: t.id, className: 'vscp-tab', 'data-active': on ? 'true' : 'false', 'data-testid': 'vscode-pane-tab', 'data-tab-id': t.id, 'data-session': t.session || '' },
          h('button', {
            type: 'button', role: 'tab', 'aria-selected': on ? 'true' : 'false', tabIndex: on ? 0 : -1, className: 'vscp-tab-main',
            title: tabTooltip(t, titles), onClick: () => selectTab(t.id),
            onAuxClick: (e) => { if (e.button === 1 && t.id !== 'legacy') closeTab(t.id); },
          },
          h(Icon, { name: t.session ? 'chat' : 'folder' }),
          h('span', { className: 'vscp-truncate' }, label)),
          t.id === 'legacy' ? null : h('button', {
            type: 'button', className: 'vscp-tab-close', 'aria-label': `Close ${label}`, title: 'Close tab', 'data-testid': 'vscode-pane-tab-close',
            onClick: () => closeTab(t.id),
          }, h(Icon, { name: 'close', size: 14 })));
      })),
    h('button', {
      ref: newTabBtnRef, type: 'button', className: 'vscp-icon-btn', 'aria-label': 'New VS Code tab', title: 'New tab',
      'aria-haspopup': 'dialog', 'aria-expanded': newTabOpen ? 'true' : 'false', 'data-testid': 'vscode-pane-new-tab', disabled: !tabsKnown,
      onClick: () => {
        setMenuOpen(false);
        setTabError('');
        setNewTabOpen((o) => !o);
      },
    }, h(Icon, { name: 'plus' })),
    h('span', { className: 'vscp-spacer' }),
    h('button', {
      ref: menuBtnRef, type: 'button', className: 'vscp-icon-btn', 'aria-haspopup': 'menu', 'aria-expanded': menuOpen ? 'true' : 'false',
      'aria-label': `VS Code menu. ${statusText}`, title: statusText, 'data-testid': 'vscode-pane-menu-button',
      'data-status': status, 'data-kc-connected': kcConnected ? 'true' : 'false', 'data-update': updateAvailable ? 'available' : '',
      onClick: () => {
        setNewTabOpen(false);
        setMenuOpen((o) => !o);
      },
    },
    h('span', { className: 'vscp-dot', style: { background: STATUS_VAR[status] || STATUS_VAR.idle } }),
    h(Icon, { name: 'more' }),
    updateAvailable ? h('span', { className: 'vscp-badge', 'aria-hidden': 'true' }) : null),
  );

  const menu = menuOpen ? h(Popover, { anchor: menuBtnRef, onClose: closeMenu, role: 'menu', label: 'VS Code', testid: 'vscode-pane-menu', kind },
    h('div', { className: 'vscp-info', role: 'none', 'data-testid': 'vscode-pane-status' },
      h('span', { className: 'vscp-dot', style: { background: STATUS_VAR[status] || STATUS_VAR.idle } }),
      h('span', null, statusText)),
    menuItem('Reload this tab', act(reloadActive), { disabled: !ready, testid: 'vscode-pane-reload' }),
    menuItem('Restart the VS Code server', act(doRestart), { testid: 'vscode-pane-restart' }),
    ownsServer ? menuItem(button.label, act(doCheckUpdate), { disabled: updateBusy, testid: 'vscode-pane-update-check' }) : null,
    ownsServer && banner && banner.install ? menuItem(banner.installLabel, act(() => doInstallUpdate(banner.install)), { disabled: updateBusy, testid: 'vscode-pane-update-install-menu' }) : null,
    h('div', { className: 'vscp-sep', role: 'separator' }),
    h('div', {
      className: 'vscp-info', role: 'none', 'data-testid': 'vscode-pane-kc-state', 'data-connected': kcConnected ? 'true' : 'false',
      title: kcConnected ? '' : (kcState && (kcState.lastError || kcState.reason)) || '',
    },
    h('span', { className: 'vscp-dot', style: { background: kcConnected ? STATUS_VAR.ready : STATUS_VAR.idle } }),
    h('span', null, kcConnected ? 'The Kiro Crew tab in VS Code is signed in' : 'The Kiro Crew tab in VS Code is not signed in')),
    kcAvailable ? menuItem(kcConnected ? 'Disconnect the Kiro Crew tab' : 'Connect the Kiro Crew tab', act(kcConnected ? kcDisconnect : () => signIn('connect')), {
      disabled: kcBusy, testid: kcConnected ? 'vscode-pane-kc-disconnect' : 'vscode-pane-kc-connect',
    }) : null,
    menuItem('Show the Kiro Crew tab in VS Code', act(revealCrew), { disabled: !ready, testid: 'vscode-pane-crew-reveal' }),
    activeText ? h('div', { className: 'vscp-sep', role: 'separator' }) : null,
    activeText ? h('div', { className: 'vscp-info', role: 'none', title: activeText, 'data-testid': 'vscode-pane-active-file' }, `Active file: ${baseName(active.path)}${active.selection ? `:${active.selection.startLine}` : ''}`) : null,
  ) : null;

  const recentList = recent.slice(0, 8);
  const newTabPanel = newTabOpen ? h(Popover, { anchor: newTabBtnRef, onClose: closeNewTab, role: 'dialog', label: 'New VS Code tab', testid: 'vscode-pane-new-tab-panel', kind, align: 'left', focusFirst: false },
    h('form', {
      className: 'vscp-newtab', 'data-testid': 'vscode-pane-new-tab-form',
      onSubmit: (e) => {
        e.preventDefault();
        openFolderTab(folderInput);
      },
    },
    h('label', { htmlFor: 'vscp-folder', className: 'vscp-muted' }, 'Folder'),
    h('input', {
      id: 'vscp-folder', className: 'vscp-input', style: { flex: '1 1 auto', minWidth: 220 }, value: folderInput, autoFocus: true,
      placeholder: (session && session.defaultFolder) || '', spellCheck: false, onChange: (e) => setFolderInput(e.target.value),
    }),
    h('button', { type: 'submit', className: 'vscp-btn vscp-btn-primary' }, 'Open')),
    tabError ? h('div', { className: 'vscp-info', role: 'alert', style: { color: 'var(--vscp-danger)' } }, tabError) : null,
    recentList.length ? h('div', { className: 'vscp-sep', role: 'separator' }) : null,
    recentList.length ? h('div', { className: 'vscp-info', role: 'none' }, 'Recent projects') : null,
    recentList.map((d) => h('button', { key: d, type: 'button', className: 'vscp-item', title: d, onClick: () => openFolderTab(d) },
      h(Icon, { name: 'folder' }),
      h('span', { className: 'vscp-truncate', style: { flex: 'none', maxWidth: 160 } }, baseName(d)),
      h('span', { className: 'vscp-muted vscp-truncate', style: { flex: '1 1 auto' } }, d))),
  ) : null;

  let overlay = null;
  const failed = status === 'error';
  if (!showFrame && originAdvice) {
    const cmd = 'kirocrew restart';
    overlay = h('div', { className: 'vscp-overlay', 'data-testid': 'vscode-pane-origin-advice' },
      h('div', { style: { maxWidth: 600 } },
        h('div', { style: { fontSize: 15, marginBottom: 8 } }, originAdvice.title),
        h('div', { className: 'vscp-muted' }, originAdvice.message),
        allowResult && allowResult.ok
          ? h('div', { className: 'vscp-muted', style: { marginTop: 10 }, role: 'status' },
            allowResult.changed ? `Added port ${originPort} to ${allowResult.file}. ` : `Port ${originPort} was already listed in ${allowResult.file}. `,
            'Now restart Kiro Crew on that machine: ', h('code', null, cmd), '.')
          : null,
        allowResult && !allowResult.ok
          ? h('div', { className: 'vscp-note', style: { marginTop: 10 }, role: 'alert' }, `Could not change it: ${allowResult.error}. Add ${originCheck.variable || 'KIROCREW_ALLOWED_LOOPBACK_PORTS'}=${[...(originCheck.listed || []), Number(originPort)].join(',')} to ${originCheck.envFile || '~/.kiro/crew/.env'} on that machine yourself, then restart Kiro Crew there.`)
          : null,
        h('div', { style: { marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' } },
          originAdvice.allow && !(allowResult && allowResult.ok)
            ? h('button', { type: 'button', className: 'vscp-btn vscp-btn-primary', disabled: allowing, onClick: allowPort, 'data-testid': 'vscode-pane-allow-port' }, allowing ? 'Adding...' : `Allow port ${originPort}`)
            : null,
          (originAdvice.restart || (allowResult && allowResult.ok)) && navigator.clipboard && navigator.clipboard.writeText
            ? h('button', { type: 'button', className: 'vscp-btn', onClick: () => navigator.clipboard.writeText(cmd).then(() => say('Command copied'), () => {}) }, 'Copy restart command')
            : null,
          originAdvice.again
            ? h('button', { type: 'button', className: 'vscp-btn', onClick: () => { setAllowResult(null); setOriginCheck(null); setOriginTry((n) => n + 1); } }, 'Check again')
            : null)));
  } else if (!showFrame && !failed && tabsKnown && !tabList.length && !tabsInfo.fresh) {
    overlay = h('div', { className: 'vscp-overlay', 'data-testid': 'vscode-pane-empty' },
      h('div', { style: { maxWidth: 520 } },
        h('div', { style: { fontSize: 15, marginBottom: 8 } }, 'No VS Code tab is open'),
        h('div', { className: 'vscp-muted' }, 'Open a folder in a new tab, or use the VS Code button in a chat to open VS Code on that chat\'s project with the chat beside it.'),
        h('button', { type: 'button', className: 'vscp-btn vscp-btn-primary', style: { marginTop: 12 }, onClick: () => setNewTabOpen(true) }, 'Open a folder')));
  } else if (!showFrame) {
    const backendDown = Boolean(sessionProblem && sessionProblem.backendDown);
    const canInstall = failed && !sessionProblem && Boolean(session && session.action === 'install-server');
    const primary = canInstall ? { label: 'Download VS Code server', onClick: doInstall } : backendDown ? { label: 'Check again', onClick: loadSession } : { label: 'Try again', onClick: doRestart };
    overlay = h('div', { className: 'vscp-overlay' },
      h('div', { style: { maxWidth: 560 } },
        h('div', { style: { fontSize: 15, marginBottom: 8 } }, failed ? (sessionProblem ? sessionProblem.title : canInstall ? session.message : 'VS Code could not start') : 'Starting VS Code...'),
        h('div', { className: 'vscp-muted' }, canInstall && session.error ? session.error : statusText),
        failed ? h('button', { type: 'button', className: 'vscp-btn vscp-btn-primary', style: { marginTop: 12 }, onClick: primary.onClick }, primary.label) : null));
  }

  return h('div', {
    ref: rootRef,
    // `sidebar sidebar-inner` are the theme hooks the Sessions panel card carries
    // (listShell.ts), so theme packs that retint that card retint this one.
    className: 'vscp-themed vscp-card sidebar sidebar-inner',
    'data-vscp-kind': kind,
    // The height is set on every placement from the space left in <main>, so the card
    // neither grows past the window nor depends on how the host wraps the page.
    style: { flex: '0 0 auto' },
    'data-testid': 'vscode-pane-card',
  },
  toolbar,
  menu,
  newTabPanel,
  // Chat cannot reach Kiro Crew for a reason only the user can fix (an Update
  // left the new API permissions unapproved).
  session && session.chat && session.chat.message
    ? h('div', { className: 'vscp-note', role: 'alert', 'data-testid': 'vscode-pane-chat-problem' }, `VS Code Chat: ${session.chat.message}`)
    : null,
  // The tab cannot sign in by itself until the dashboard has a URL (V5 S-1):
  // say so with the one command that fixes it. Nothing is changed for you.
  kcAvailable && !kcConnected && kcState && kcState.lastCode === 'external_origin_unavailable'
    ? h('div', { className: 'vscp-note', role: 'status', 'data-testid': 'vscode-pane-kc-setup' },
      'VS Code\'s Kiro Crew tab signs in with a link this dashboard mints, and it can mint one only once Settings has a dashboard URL. Run ',
      h('code', { 'data-testid': 'vscode-pane-kc-setup-command' }, dashboardUrlCommand()),
      ' and restart Kiro Crew; the tab then signs in by itself. Or paste a kirocrew token link into the tab. ',
      h('button', {
        type: 'button', className: 'vscp-btn', 'data-testid': 'vscode-pane-kc-setup-copy',
        onClick: () => {
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(dashboardUrlCommand()).then(() => say('Command copied'), () => say('Copy the command by hand'));
        },
      }, 'Copy command'))
    : null,
  ownsServer && banner ? h('div', { className: 'vscp-note', role: banner.tone === 'error' ? 'alert' : 'status', 'data-testid': 'vscode-pane-update-note' },
    banner.text,
    banner.install ? h('button', { type: 'button', className: 'vscp-btn vscp-btn-primary', style: { marginLeft: 8 }, disabled: updateBusy, onClick: () => doInstallUpdate(banner.install), 'data-testid': 'vscode-pane-update-install' }, banner.installLabel) : null) : null,
  tabError && !newTabOpen ? h('div', { className: 'vscp-note', role: 'alert', 'data-testid': 'vscode-pane-tab-error' }, tabError) : null,
  flash ? h('div', { className: 'vscp-note', role: flash.tone === 'error' ? 'alert' : 'status', 'data-testid': 'vscode-pane-flash' }, flash.text) : null,
  h('div', { ref: placeholderRef, className: 'vscp-body', 'data-testid': 'vscode-pane-frame-slot', 'data-frame-key': key || '', 'data-tab-id': activeTab ? activeTab.id : '' }, overlay));
}
