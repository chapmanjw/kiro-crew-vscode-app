// vscode-pane UI page (plain ESM, no build step). The dashboard imports this
// module into its own React tree; 'react' and '@kirocrew/app-sdk' resolve
// through the host's import map. The file name carries the version so
// Electron's code cache cannot pin an old copy after an Update.
//
// The VS Code iframe does not live in the React tree. The dashboard unmounts an
// app page whenever the user goes to another route (App.tsx renders one
// <Route path="/apps/:name"> element), and an iframe that is removed from the
// document is destroyed, so VS Code started over on every return. The frame is
// therefore kept in one host element attached to document.body, placed over
// the page's placeholder while the page is mounted and hidden (never removed)
// while it is not.
import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { useAppApi, useTheme } from '@kirocrew/app-sdk';
import {
  API,
  THEME_VARS,
  buildThemePayload,
  folderFromSearch,
  frameKey,
  framePlacement,
} from './vscode-pane-core-0.3.0.mjs';

const h = React.createElement;
const FOLDER_KEY = 'kc:vscode-pane:folder';
// Card geometry of the Kiro Crew Sessions panel (website/src/components/listShell.ts
// LIST_SHELL_CLS: `rounded-xl` = --radius-xl, 1px --border, --bg-elevated,
// --shadow-sm) and its 8px inset from the window (App.tsx FOCUS_INSET, the
// drawer's `pb-2`).
const INSET = 8;
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

const STYLE_ID = 'vscode-pane-style-0-3-0';
const CSS = `
.vscp-card{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;box-sizing:border-box;
  margin:${INSET}px;background:var(--bg-elevated,#1a1d25);color:var(--text,#e4e4e7);
  border:1px solid var(--border,#27272a);border-radius:var(--radius-xl,${RADIUS_FALLBACK}px);box-shadow:var(--shadow-sm,none);
  font-family:var(--font-body,system-ui,sans-serif)}
.vscp-bar{display:flex;flex-wrap:nowrap;align-items:center;gap:6px;height:34px;min-height:34px;padding:0 8px 0 12px;
  box-sizing:border-box;border-bottom:1px solid var(--border,#27272a);font-size:12px;overflow:hidden;white-space:nowrap}
.vscp-group{display:flex;align-items:center;gap:4px;min-width:0}
.vscp-muted{color:var(--muted,#909098)}
.vscp-input{font:inherit;font-size:12px;height:24px;box-sizing:border-box;padding:0 6px;border-radius:var(--radius-sm,6px);min-width:0;
  border:1px solid var(--border,#27272a);background:var(--bg,#12141a);color:var(--text,#e4e4e7);outline:none}
.vscp-input:focus{border-color:var(--accent,#00d492);box-shadow:0 0 0 1px var(--ring,var(--accent,#00d492))}
.vscp-btn{font:inherit;font-size:12px;height:24px;box-sizing:border-box;padding:0 8px;border-radius:var(--radius-sm,6px);cursor:pointer;
  border:1px solid var(--border,#27272a);background:transparent;color:var(--text,#e4e4e7);white-space:nowrap}
.vscp-btn:hover{background:var(--bg-hover,#262a35);border-color:var(--border-strong,#3f3f46)}
.vscp-btn:focus-visible{outline:2px solid var(--ring,var(--accent,#00d492));outline-offset:1px}
.vscp-btn-primary{background:var(--accent,#00d492);color:var(--accent-fg,#000);border-color:transparent}
.vscp-btn-primary:hover{background:var(--accent-hover,var(--accent,#00d492));border-color:transparent}
.vscp-dot{width:8px;height:8px;border-radius:4px;display:inline-block;flex:none}
.vscp-sep{width:1px;height:16px;background:var(--border,#27272a);flex:none}
.vscp-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.vscp-body{position:relative;flex:1 1 auto;min-height:0;background:var(--bg,#12141a)}
.vscp-overlay{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:24px;font-size:13px}
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

const STATUS_VAR = {
  ready: 'var(--ok,#22c55e)',
  starting: 'var(--warn,#eab308)',
  provisioning: 'var(--warn,#eab308)',
  error: 'var(--danger,#ef4444)',
  stopped: 'var(--muted,#909098)',
  idle: 'var(--muted,#909098)',
};

// ---------------------------------------------------------------------------
// The detached frame host (one per document)
// ---------------------------------------------------------------------------

const holder = {
  wrap: null,
  iframe: null,
  key: null,
  nonce: 0,
  loads: 0,
  session: null, // last session seen, so a remount shows the live frame at once
  owner: null, // the mounted page's token, or null while unmounted
};

function ensureFrame() {
  if (holder.wrap && holder.wrap.isConnected) return holder;
  const wrap = document.createElement('div');
  wrap.setAttribute('data-vscode-pane-frame-host', '');
  // Fixed on <body>, above the dashboard's <main> content but under its
  // popovers and dialogs (z-50 and up), and invisible until a page claims it.
  Object.assign(wrap.style, {
    position: 'fixed', left: '0px', top: '0px', width: '0px', height: '0px', zIndex: '2',
    visibility: 'hidden', pointerEvents: 'none', overflow: 'hidden', background: 'var(--bg,#12141a)',
  });
  const iframe = document.createElement('iframe');
  iframe.title = 'VS Code';
  iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
  Object.assign(iframe.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', border: '0', display: 'block' });
  wrap.appendChild(iframe);
  document.body.appendChild(wrap);
  holder.wrap = wrap;
  holder.iframe = iframe;
  holder.key = null;
  return holder;
}

function loadFrame(key, url) {
  ensureFrame();
  if (holder.key === key) return;
  holder.key = key;
  holder.loads += 1;
  holder.wrap.setAttribute('data-loads', String(holder.loads));
  holder.iframe.src = url;
}

function hideFrame() {
  if (!holder.wrap) return;
  // Keyboard focus must not stay in a frame nobody can see.
  if (document.activeElement === holder.iframe) holder.iframe.blur();
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

// Test and debug hook: the smoke harness reads load counts from here.
if (typeof window !== 'undefined') window.__vscodePane = holder;

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
    const declared = getComputedStyle(probe);
    for (const name of THEME_VARS) {
      if (!declared.getPropertyValue(name).trim()) continue;
      probe.style.color = '';
      probe.style.color = `var(${name})`;
      const computed = getComputedStyle(probe).color; // rgb(), rgba(), or color(srgb ...) for color-mix
      if (!computed) continue;
      // Paint it to read back sRGB bytes; this handles every syntax the browser knows.
      if (ctx) {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = computed;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
        raw[name] = `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`;
      } else {
        raw[name] = computed;
      }
    }
  } finally {
    probe.remove();
  }
  return raw;
}

function currentThemePayload() {
  const name = document.documentElement.dataset.theme || '';
  return buildThemePayload(readThemeRaw(), name);
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function readStoredFolder() {
  try {
    return window.localStorage.getItem(FOLDER_KEY) || '';
  } catch {
    return '';
  }
}

function storeFolder(v) {
  try {
    if (v) window.localStorage.setItem(FOLDER_KEY, v);
    else window.localStorage.removeItem(FOLDER_KEY);
  } catch {
    /* storage blocked */
  }
}

export default function VsCodePane() {
  ensureStyle();
  // The host may hand a new client object per render; read it through a ref so
  // polling effects do not restart on every render.
  const apiNow = useAppApi();
  const apiRef = useRef(apiNow);
  apiRef.current = apiNow;
  const api = {
    get: (...a) => apiRef.current.get(...a),
    post: (...a) => apiRef.current.post(...a),
  };
  const sdkTheme = useTheme();
  // A `?folder=` (the composer's VS Code button) wins over the remembered folder.
  const [folder, setFolder] = useState(() => {
    const asked = folderFromSearch(window.location.search);
    if (asked) storeFolder(asked);
    return asked || readStoredFolder();
  });
  const [folderInput, setFolderInput] = useState(folder);
  const [session, setSession] = useState(holder.session);
  const [sessionError, setSessionError] = useState('');
  const [recent, setRecent] = useState([]);
  const [nonce, setNonce] = useState(holder.nonce);
  const [openPath, setOpenPath] = useState('');
  const [openLine, setOpenLine] = useState('');
  const [openResult, setOpenResult] = useState('');
  const [editor, setEditor] = useState(null);
  const rootRef = useRef(null);
  const placeholderRef = useRef(null);

  const ready = !!(session && session.ready && session.url);
  const key = frameKey(session, nonce);

  const applyFolder = useCallback((value) => {
    const v = (value || '').trim();
    setFolder(v);
    setFolderInput(v);
    storeFolder(v);
  }, []);

  // The route can change under a mounted page (another chat's VS Code button
  // while this page is open): follow a new `?folder=`.
  useEffect(() => {
    let last = folderFromSearch(window.location.search);
    const check = () => {
      const now = folderFromSearch(window.location.search);
      if (now && now !== last) applyFolder(now);
      last = now;
    };
    const timer = setInterval(check, 400);
    window.addEventListener('popstate', check);
    return () => {
      clearInterval(timer);
      window.removeEventListener('popstate', check);
    };
  }, [applyFolder]);

  const loadSession = useCallback(async () => {
    try {
      const q = folder ? `?folder=${encodeURIComponent(folder)}` : '';
      const s = await call(api.get(`${API}/session${q}`));
      holder.session = s;
      setSession(s);
      setSessionError('');
      if (!folder && s.folder) setFolderInput((cur) => cur || s.folder);
    } catch (e) {
      setSessionError(errText(e));
    }
  }, [folder]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the session: every 1.5 s while VS Code starts, every 2 s once it is up
  // so a server restart (new generation) is seen quickly.
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

  // VS Code -> Kiro Crew: the active editor as the bridge extension reports it.
  useEffect(() => {
    if (!ready) return undefined;
    let alive = true;
    let timer;
    const tick = async () => {
      try {
        const st = await call(api.get(`${API}/state`));
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
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    call(api.get('/api/recent-projects'))
      .then((r) => alive && Array.isArray(r.dirs) && setRecent(r.dirs.slice(0, 20)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Theme: send the dashboard palette on mount, on every theme change, and to
  // each new server generation (a restarted server starts from defaults).
  const lastTheme = useRef('');
  const postTheme = useCallback((force) => {
    let payload;
    try {
      payload = currentThemePayload();
    } catch {
      return;
    }
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

  const generation = session && session.generation;
  useEffect(() => {
    if (ready) postTheme(true);
  }, [ready, generation, postTheme]);

  // Load the workbench into the detached frame only when its identity changes,
  // so polling, remounts and route changes never reload it.
  useEffect(() => {
    if (key && session) loadFrame(key, session.url);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Claim the frame while mounted; place it over the placeholder every frame
  // (handles window resize, side panels opening, scroll and zoom) and size the
  // card to the space left in the dashboard's <main>.
  const showFrame = ready && !!key;
  const showRef = useRef(showFrame);
  showRef.current = showFrame;
  useLayoutEffect(() => {
    const token = {};
    holder.owner = token;
    let raf = 0;
    let lastHeight = '';
    const tick = () => {
      raf = requestAnimationFrame(tick);
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
      const want = `${Math.max(240, Math.floor(bounds.top + bounds.height - rr.top - INSET))}px`;
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
      const p = framePlacement(ph.getBoundingClientRect(), bounds, [0, 0, inner, inner]);
      if (p) placeFrame(p);
      else hideFrame();
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      if (holder.owner === token) {
        holder.owner = null;
        hideFrame();
      }
    };
  }, []);

  const reloadFrame = () => {
    holder.nonce += 1;
    setNonce(holder.nonce);
  };

  const doOpen = async (ev) => {
    ev.preventDefault();
    if (!openPath.trim()) return;
    setOpenResult('Opening...');
    try {
      const body = { path: openPath.trim() };
      if (openLine.trim()) body.line = Number(openLine.trim());
      const r = await call(api.post(`${API}/open`, body));
      setOpenResult(
        r.ok ? 'Opened in VS Code' : r.timeout ? (r.delivered ? 'Sent; VS Code did not confirm' : 'Queued; VS Code bridge is not connected yet') : `Failed: ${r.error || 'unknown error'}`,
      );
    } catch (e) {
      setOpenResult(`Failed: ${errText(e)}`);
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

  const status = session ? session.status : sessionError ? 'error' : 'idle';
  const statusText = sessionError
    ? `Backend unreachable: ${sessionError}`
    : session
      ? session.error
        ? `${session.message}: ${session.error}`
        : session.message || session.status
      : 'Connecting to the vscode-pane backend...';

  const active = editor && editor.activeEditor;
  const activeText = active
    ? `${active.path}${active.selection ? `:${active.selection.startLine}:${active.selection.startColumn}` : ''}`
    : 'no file';

  const toolbar = h(
    'div',
    { className: 'vscp-bar', role: 'toolbar', 'aria-label': 'VS Code controls' },
    h('span', { className: 'vscp-group', title: statusText, role: 'status' },
      h('span', { className: 'vscp-dot', style: { background: STATUS_VAR[status] || STATUS_VAR.idle } }),
      h('span', null, ready ? 'VS Code' : status)),
    h('span', { className: 'vscp-sep', 'aria-hidden': 'true' }),
    h('form', {
      className: 'vscp-group', style: { flex: '1 1 240px' },
      onSubmit: (e) => { e.preventDefault(); applyFolder(folderInput); },
    },
      h('label', { htmlFor: 'vscp-folder', className: 'vscp-muted' }, 'Folder'),
      h('input', {
        id: 'vscp-folder', className: 'vscp-input', style: { flex: '1 1 auto' }, list: 'vscp-recent', value: folderInput,
        placeholder: session ? session.defaultFolder || '' : '', onChange: (e) => setFolderInput(e.target.value),
        spellCheck: false,
      }),
      h('datalist', { id: 'vscp-recent' }, recent.map((d) => h('option', { key: d, value: d }))),
      h('button', { type: 'submit', className: 'vscp-btn' }, 'Open folder')),
    h('button', { type: 'button', className: 'vscp-btn', onClick: reloadFrame, title: 'Reload the VS Code view' }, 'Reload'),
    h('button', { type: 'button', className: 'vscp-btn', onClick: doRestart, title: 'Restart the VS Code server process' }, 'Restart server'),
    h('span', { className: 'vscp-sep', 'aria-hidden': 'true' }),
    h('form', { className: 'vscp-group', style: { flex: '1 1 220px' }, onSubmit: doOpen },
      h('label', { htmlFor: 'vscp-open', className: 'vscp-muted' }, 'Open file'),
      h('input', {
        id: 'vscp-open', className: 'vscp-input', style: { flex: '1 1 auto' }, value: openPath, placeholder: 'C:\\path\\to\\file',
        onChange: (e) => setOpenPath(e.target.value), spellCheck: false,
      }),
      h('input', {
        className: 'vscp-input', style: { width: 46, flex: 'none' }, value: openLine, placeholder: 'line', inputMode: 'numeric', 'aria-label': 'Line',
        onChange: (e) => setOpenLine(e.target.value.replace(/[^0-9]/g, '')),
      }),
      h('button', { type: 'submit', className: 'vscp-btn' }, 'Open'),
      openResult ? h('span', { className: 'vscp-muted vscp-truncate', role: 'status', style: { maxWidth: 160 } }, openResult) : null),
    h('span', { className: 'vscp-group vscp-muted', style: { flex: '0 1 220px' }, title: `Active file reported by VS Code: ${activeText}` },
      h('span', { className: 'vscp-dot', style: { background: editor && editor.connected ? STATUS_VAR.ready : STATUS_VAR.idle } }),
      h('span', { className: 'vscp-truncate' }, `Active: ${activeText}`)),
  );

  let overlay = null;
  if (!showFrame) {
    const failed = status === 'error';
    overlay = h('div', { className: 'vscp-overlay' },
      h('div', null,
        h('div', { style: { fontSize: 15, marginBottom: 8 } }, failed ? 'VS Code could not start' : 'Starting VS Code...'),
        h('div', { className: 'vscp-muted' }, statusText),
        failed ? h('button', { type: 'button', className: 'vscp-btn vscp-btn-primary', style: { marginTop: 12 }, onClick: doRestart }, 'Try again') : null));
  }

  return h('div', {
    ref: rootRef,
    // `sidebar sidebar-inner` are the theme hooks the Sessions panel card carries
    // (listShell.ts), so theme packs that retint that card retint this one.
    className: 'vscp-card sidebar sidebar-inner',
    // The height is set every frame from the space left in <main>, so the card
    // neither grows past the window nor depends on how the host wraps the page.
    style: { flex: '0 0 auto' },
    'data-testid': 'vscode-pane-card',
  },
  toolbar,
  h('div', { ref: placeholderRef, className: 'vscp-body', 'data-testid': 'vscode-pane-frame-slot', 'data-frame-key': key || '' }, overlay));
}
