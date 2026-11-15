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
//
// The Kiro Crew chat lives in VS Code itself: the bridge's "Kiro Crew" tab in
// VS Code's secondary side bar frames Kiro Crew's own dashboard chat through
// the launcher's tunnel (backend/lib/kcproxy.mjs). This page signs that tunnel
// in: it runs inside the signed-in dashboard, so it asks the dashboard for a
// sign-in link (POST /api/auth/mobile-link, the "Connect your phone" mint) and
// hands it to the launcher (POST /api/kc/sign-in), once when the page opens and
// again whenever the tab's Connect button asks.
import React, { useState, useEffect, useCallback, useRef, useLayoutEffect, useMemo } from 'react';
import { useAppApi, useTheme } from '@kirocrew/app-sdk';
import {
  API,
  THEME_VARS,
  buildThemePayload,
  resolveKind,
  folderFromSearch,
  frameKey,
  framePlacement,
  CARD_MARGIN,
} from './vscode-pane-core-0.5.0.mjs';

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

const STYLE_ID = 'vscode-pane-style-0-5-0';
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
.vscp-bar{display:flex;flex-wrap:nowrap;align-items:center;gap:6px;height:34px;min-height:34px;padding:0 8px 0 12px;
  box-sizing:border-box;border-bottom:1px solid var(--vscp-border);font-size:12px;overflow:hidden;white-space:nowrap}
.vscp-group{display:flex;align-items:center;gap:4px;min-width:0}
.vscp-muted{color:var(--vscp-muted)}
.vscp-input{font:inherit;font-size:12px;height:24px;box-sizing:border-box;padding:0 6px;border-radius:var(--radius-sm,6px);min-width:0;
  border:1px solid var(--vscp-border);background:var(--vscp-bg);color:var(--vscp-text);outline:none}
.vscp-input:focus{border-color:var(--vscp-accent);box-shadow:0 0 0 1px var(--vscp-ring)}
.vscp-btn{font:inherit;font-size:12px;height:24px;box-sizing:border-box;padding:0 8px;border-radius:var(--radius-sm,6px);cursor:pointer;
  border:1px solid var(--vscp-border);background:transparent;color:var(--vscp-text);white-space:nowrap}
.vscp-btn:hover{background:var(--vscp-hover);border-color:var(--vscp-border-strong)}
.vscp-btn:focus-visible{outline:2px solid var(--vscp-ring);outline-offset:1px}
.vscp-btn-on{background:var(--vscp-hover);border-color:var(--vscp-border-strong)}
.vscp-btn-primary{background:var(--vscp-accent);color:var(--vscp-accent-fg);border-color:transparent}
.vscp-btn-primary:hover{background:var(--vscp-accent-hover);border-color:transparent}
.vscp-dot{width:8px;height:8px;border-radius:4px;display:inline-block;flex:none}
.vscp-sep{width:1px;height:16px;background:var(--vscp-border);flex:none}
.vscp-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.vscp-body{position:relative;flex:1 1 auto;min-height:0;min-width:0;background:var(--vscp-bg)}
.vscp-overlay{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:24px;font-size:13px}
.vscp-frame-host{background:var(--vscp-bg)}
.vscp-note{padding:6px 12px;font-size:12px;line-height:1.4;border-bottom:1px solid var(--vscp-border);color:var(--vscp-text);
  background:color-mix(in srgb,var(--vscp-warn) 14%,var(--vscp-elev));white-space:normal}
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

// ---------------------------------------------------------------------------
// The detached frame host (one per document)
// ---------------------------------------------------------------------------

const holder = {
  wrap: null,
  iframe: null,
  key: null,
  nonce: 0,
  loads: 0,
  placements: 0, // how often the frame was placed (the smoke checks it is not every frame)
  session: null, // last session seen, so a remount shows the live frame at once
  owner: null, // the mounted page's token, or null while unmounted
  kind: '', // last resolved dashboard kind, so a remount styles itself at once
  // Tunnel sign-in from this page (the smoke reads these).
  kcAutoEpoch: null, // the tunnel epoch the automatic attempt last ran for (once per page load and epoch)
  kcSeenConnect: null, // last connectRequests reading
  sessionSeq: 0, // GET /api/session requests sent
  sessionApplied: 0, // the newest one applied
  kcMints: [], // {via, ok, status} of each mint attempt
};

function ensureFrame() {
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

/**
 * Mint a sign-in link with the dashboard's own session and give it to the
 * launcher. The page is a module inside the dashboard document, so a plain
 * same-origin fetch carries the dashboard's HttpOnly session cookie; the
 * gateway refuses app tokens on this route (handlers/auth_mobile.py:83-88), so
 * it must be the user's session, not useAppApi. It answers 409
 * external_origin_unavailable until Settings has a dashboard URL
 * (auth_mobile.py:105-111); the tab then offers the paste field.
 */
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
  const [kind, setKind] = useState(holder.kind || 'dark');
  const rootRef = useRef(null);
  const placeholderRef = useRef(null);
  const [crewResult, setCrewResult] = useState('');
  const [kcBusy, setKcBusy] = useState(false);

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
    // Overlapping polls (a folder change restarts the loop while one is in
    // flight) must not let an older answer overwrite a newer one.
    const seq = ++holder.sessionSeq;
    try {
      const q = folder ? `?folder=${encodeURIComponent(folder)}` : '';
      const s = await call(api.get(`${API}/session${q}`));
      if (seq < holder.sessionApplied) return;
      holder.sessionApplied = seq;
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

  const revealCrew = async () => {
    setCrewResult('');
    try {
      const r = await call(api.post(`${API}/crew/view`, { action: 'reveal' }));
      if (!r.ok) setCrewResult(r.timeout ? 'VS Code did not answer' : `Could not open: ${r.error || 'unknown error'}`);
    } catch (e) {
      setCrewResult(`Could not open: ${errText(e)}`);
    }
  };

  const generation = session && session.generation;
  const instance = session && session.instance;
  useEffect(() => {
    if (ready) postTheme(true);
  }, [ready, generation, instance, postTheme]);

  // Load the workbench into the detached frame only when its identity changes,
  // so polling, remounts and route changes never reload it.
  useEffect(() => {
    if (key && session) loadFrame(key, session.url);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Claim the frame while mounted; place it over the placeholder and size the
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
      const p = framePlacement(ph.getBoundingClientRect(), bounds, [0, 0, inner, inner]);
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
    h('button', {
      type: 'button', className: 'vscp-btn', onClick: revealCrew, disabled: !ready,
      title: crewResult || 'Open the Kiro Crew tab in VS Code (Ctrl+Alt+K in VS Code)', 'data-testid': 'vscode-pane-crew-reveal',
    }, 'Kiro Crew'),
    h('span', {
      className: 'vscp-group vscp-muted', 'data-testid': 'vscode-pane-kc-state',
      'data-connected': kcConnected ? 'true' : 'false',
      title: kcConnected
        ? 'VS Code\'s Kiro Crew tab is signed in to this Kiro Crew'
        : (kcState && kcState.lastError) || (kcState && kcState.reason) || 'VS Code\'s Kiro Crew tab is not signed in',
    },
    h('span', { className: 'vscp-dot', style: { background: kcConnected ? STATUS_VAR.ready : STATUS_VAR.idle } }),
    h('span', null, kcConnected ? 'Tab connected' : 'Tab not connected')),
    kcAvailable
      ? h('button', {
        type: 'button', className: 'vscp-btn', disabled: kcBusy, 'data-testid': kcConnected ? 'vscode-pane-kc-disconnect' : 'vscode-pane-kc-connect',
        onClick: kcConnected ? kcDisconnect : () => signIn('connect'),
        title: kcConnected ? 'Sign VS Code\'s Kiro Crew tab out' : 'Sign VS Code\'s Kiro Crew tab in with this dashboard\'s session',
      }, kcConnected ? 'Disconnect' : 'Connect')
      : null,
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
    className: 'vscp-themed vscp-card sidebar sidebar-inner',
    'data-vscp-kind': kind,
    // The height is set on every placement from the space left in <main>, so the card
    // neither grows past the window nor depends on how the host wraps the page.
    style: { flex: '0 0 auto' },
    'data-testid': 'vscode-pane-card',
  },
  toolbar,
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
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(dashboardUrlCommand()).then(() => setCrewResult('Command copied'), () => setCrewResult('Copy the command by hand'));
        },
      }, 'Copy command'))
    : null,
  h('div', { ref: placeholderRef, className: 'vscp-body', 'data-testid': 'vscode-pane-frame-slot', 'data-frame-key': key || '' }, overlay));
}
