// The docked Kiro Crew chat column of the vscode-pane page (plain ESM, no
// build step). It renders the SDK's ChatPanel, which mounts the Kiro Crew Chat
// page's own ChatPage (app-sdk/ChatPanel.tsx), in `conversationOnly` mode:
// the session pane's transcript, tool cards, approvals, composer and pickers,
// without ChatPage's sessions rail. The column sits flush on the right of the
// card, styled like VS Code's secondary side bar: a 35px header with the Kiro
// Crew icon, the session title as a session switcher, "Open in Kiro Crew" and
// collapse, and a sash on its left edge that resizes it.
//
// ChatPanel is host React code tied to the dashboard's store, so it cannot be
// kept alive outside the page the way the VS Code iframe is: leaving the page
// unmounts it and coming back mounts it again on the same session (the
// conversation itself lives in the dashboard's store and the gateway). What
// survives in this module is the column's state: open, width and the chosen
// session per folder.
//
// Known limit: ChatPanel has no prop to pre-fill its composer (ChatPanelProps
// is {slotKey, conversationOnly, expandSteps}), so VS Code's selection cannot
// be dropped into it as a draft.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as sdk from '@kirocrew/app-sdk';
import {
  CREW_WIDTH,
  CREW_HEADER_HEIGHT,
  STORE_KEYS,
  clampCrewWidth,
  parseStoredWidth,
  normFolder,
  mainSlotTitle,
  crewSlotFromSession,
  crewSessionsForFolder,
  chatPageHref,
} from './vscode-pane-crew-core-0.4.0.mjs';

const h = React.createElement;

const STYLE_ID = 'vscode-pane-crew-style-0-4-0';
const CSS = `
.vscp-sash{flex:none;width:${CREW_WIDTH.sash}px;cursor:col-resize;background:transparent;position:relative;z-index:3;touch-action:none;outline:none}
.vscp-sash::after{content:"";position:absolute;inset:0 1px;background:transparent;transition:background-color .1s ease-out}
.vscp-sash:hover::after,.vscp-sash[data-dragging="true"]::after,.vscp-sash:focus-visible::after{background:var(--vscp-accent)}
.vscp-crew{position:relative;z-index:3;flex:none;display:flex;flex-direction:column;min-height:0;box-sizing:border-box;
  background:var(--vscp-bg);color:var(--vscp-text);border-left:1px solid var(--vscp-border)}
.vscp-crew-head{position:relative;flex:none;display:flex;align-items:center;gap:4px;height:${CREW_HEADER_HEIGHT}px;min-height:${CREW_HEADER_HEIGHT}px;
  box-sizing:border-box;padding:0 4px 0 10px;border-bottom:1px solid var(--vscp-border);background:var(--vscp-elev);font-size:12px}
.vscp-crew-icon{width:16px;height:16px;flex:none;border-radius:4px;display:grid;place-items:center;overflow:hidden}
.vscp-crew-icon img{width:16px;height:16px;display:block}
.vscp-crew-glyph{font:700 9px/16px var(--font-body,system-ui,sans-serif);color:var(--vscp-accent-fg);background:var(--vscp-accent);width:16px;height:16px;text-align:center;border-radius:4px}
.vscp-crew-title{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:4px;height:24px;padding:0 6px;border:0;border-radius:var(--radius-sm,6px);
  background:transparent;color:var(--vscp-text);font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-align:left}
.vscp-crew-title:hover,.vscp-crew-title[aria-expanded="true"]{background:var(--vscp-hover)}
.vscp-crew-title:focus-visible,.vscp-crew-act:focus-visible,.vscp-crew-item:focus-visible{outline:2px solid var(--vscp-ring);outline-offset:-1px}
.vscp-crew-act{flex:none;width:24px;height:24px;display:grid;place-items:center;border:0;border-radius:var(--radius-sm,6px);background:transparent;color:var(--vscp-muted);cursor:pointer;padding:0}
.vscp-crew-act:hover{background:var(--vscp-hover);color:var(--vscp-text)}
.vscp-crew-menu{position:absolute;top:${CREW_HEADER_HEIGHT - 2}px;left:6px;right:6px;max-height:min(360px,60vh);overflow:auto;z-index:20;padding:4px;
  background:var(--vscp-elev);color:var(--vscp-text);border:1px solid var(--vscp-border-strong);border-radius:var(--radius-md,8px);
  box-shadow:0 8px 24px color-mix(in srgb,#000 35%,transparent)}
.vscp-crew-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;min-height:28px;padding:4px 8px;border:0;border-radius:var(--radius-sm,6px);
  background:transparent;color:var(--vscp-text);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.vscp-crew-item:hover,.vscp-crew-item[aria-selected="true"]{background:var(--vscp-hover)}
.vscp-crew-item[aria-current="true"]{font-weight:600}
.vscp-crew-menu-note{padding:6px 8px;font-size:12px;color:var(--vscp-muted)}
.vscp-crew-body{position:relative;flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.vscp-crew-body>*{flex:1 1 auto;min-height:0}
.vscp-crew-empty{display:grid;place-items:center;text-align:center;padding:24px;font-size:13px;line-height:1.45;color:var(--vscp-muted)}
`;

function ensureStyle() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

// Codicon-shaped glyphs, drawn in currentColor so they follow the theme.
const svg = (d, label) =>
  h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': label ? undefined : 'true', role: label ? 'img' : undefined },
    h('path', { d }));
const ICON_EXTERNAL = 'M9 2h5v5h-1V3.7L7.4 9.3l-.7-.7L12.3 3H9V2zM3 4h4v1H3v8h8V9h1v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z';
const ICON_CLOSE_PANEL = 'M2 2h12a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm0 1v10h8V3H2zm9 0v10h3V3h-3zM5.1 5.4l.7-.7L8.1 8l-2.3 3.3-.7-.7L6.9 8 5.1 5.4z';
const ICON_CHEVRON = 'M3.6 6.1l.7-.7L8 9.1l3.7-3.7.7.7L8 10.5 3.6 6.1z';

/** The Kiro Crew mark: the dashboard serves its icon at /icon-192.png; a glyph stands in when it cannot load. */
function CrewIcon() {
  const [failed, setFailed] = useState(false);
  return h('span', { className: 'vscp-crew-icon', 'aria-hidden': 'true' },
    failed
      ? h('span', { className: 'vscp-crew-glyph' }, 'KC')
      : h('img', { src: '/icon-192.png', alt: '', onError: () => setFailed(true), draggable: false }));
}

function readStore(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key, value) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
}

/** The session chosen per folder, remembered across remounts and reloads. */
function readChosen() {
  try {
    const v = JSON.parse(readStore(STORE_KEYS.slot) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function writeChosen(folder, key) {
  const all = readChosen();
  const f = normFolder(folder);
  if (key) all[f] = key;
  else delete all[f];
  writeStore(STORE_KEYS.slot, JSON.stringify(all));
}

// Module state that outlives a remount of the page.
const crewState = {
  mounts: 0,
};
if (typeof window !== 'undefined') window.__vscodePaneCrew = crewState;

/** Rows of GET /api/chat/slots: a list, or {slots: [...]}. */
function slotRows(r) {
  if (Array.isArray(r)) return r;
  if (r && Array.isArray(r.slots)) return r.slots;
  return [];
}

/**
 * The folder's main crew slot, as the launcher names it on GET /api/session
 * (crewSlot {key, folder, title}). The launcher sends it whenever there is a
 * folder, and creates the slot in Kiro Crew pointed at the folder
 * (backend/launcher.mjs ensureCrewSlot), so the page never creates one.
 */
function mainSlot(session, folder) {
  const reported = crewSlotFromSession(session);
  const target = (session && session.folder) || folder || '';
  if (reported) return { key: reported.key, title: reported.title, folder: reported.folder || target };
  return { key: '', title: '', folder: target };
}

export function CrewColumn({ api, session, folder, onCollapse, kind }) {
  ensureStyle();
  const navigate = typeof sdk.useNavigate === 'function' ? sdk.useNavigate() : null; // eslint-disable-line react-hooks/rules-of-hooks
  const main = mainSlot(session, folder);
  const folderKey = main.folder;
  const [chosen, setChosen] = useState(() => readChosen()[normFolder(folderKey)] || '');
  const [width, setWidth] = useState(() => parseStoredWidth(readStore(STORE_KEYS.width)));
  const [menuOpen, setMenuOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const [rowsError, setRowsError] = useState('');
  const [active, setActive] = useState(0);
  const colRef = useRef(null);
  const sashRef = useRef(null);
  const titleRef = useRef(null);
  const menuRef = useRef(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    crewState.mounts += 1;
  }, []);

  // A new folder brings its own remembered choice (or its main session).
  useEffect(() => {
    setChosen(readChosen()[normFolder(folderKey)] || '');
    setRows(null);
  }, [folderKey]);

  const slotKey = chosen || main.key;
  const sessions = crewSessionsForFolder(rows || [], folderKey, main.key);
  const current = sessions.find((s) => s.key === slotKey);
  const title = (current && current.title) || (slotKey === main.key ? main.title || mainSlotTitle(folderKey) : slotKey) || 'Kiro Crew';

  const loadRows = useCallback(async () => {
    try {
      const r = await api.get('/api/chat/slots');
      setRows(slotRows(r));
      setRowsError('');
    } catch (e) {
      setRowsError((e && e.message) || String(e));
    }
  }, [api]);

  // The title needs the session list once per folder; the menu refreshes it.
  useEffect(() => {
    if (rows === null) loadRows();
  }, [rows, loadRows]);

  // Fit the stored width to the card once it is laid out, and on card resizes.
  useEffect(() => {
    const fit = () => {
      const row = colRef.current && colRef.current.parentElement;
      if (!row) return;
      const w = clampCrewWidth(widthRef.current, row.getBoundingClientRect().width);
      if (w !== widthRef.current) setWidth(w);
    };
    fit();
    const row = colRef.current && colRef.current.parentElement;
    const ro = typeof ResizeObserver === 'function' && row ? new ResizeObserver(fit) : null;
    if (ro) ro.observe(row);
    return () => ro && ro.disconnect();
  }, []);

  const commitWidth = useCallback((w) => {
    const row = colRef.current && colRef.current.parentElement;
    const next = clampCrewWidth(w, row ? row.getBoundingClientRect().width : Infinity);
    setWidth(next);
    writeStore(STORE_KEYS.width, String(next));
    return next;
  }, []);

  // Sash drag. Pointer capture does not keep the pointer once it crosses the
  // cross-site VS Code iframe (Chromium routes those moves to the frame's own
  // process), so while dragging a transparent shield covers the whole window
  // and takes every move, as VS Code does for sashes over its webviews.
  const onSashDown = (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const sash = sashRef.current;
    const col = colRef.current;
    if (!sash || !col) return;
    const right = col.getBoundingClientRect().right;
    const row = col.parentElement;
    const rowWidth = row ? row.getBoundingClientRect().width : Infinity;
    const shield = document.createElement('div');
    shield.setAttribute('data-vscode-pane-drag-shield', '');
    Object.assign(shield.style, { position: 'fixed', inset: '0', zIndex: '2147483647', cursor: 'col-resize', background: 'transparent' });
    document.body.appendChild(shield);
    sash.setAttribute('data-dragging', 'true');
    let last = widthRef.current;
    const move = (e) => {
      last = clampCrewWidth(right - e.clientX, rowWidth);
      setWidth(last);
    };
    const up = () => {
      shield.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', up);
      shield.remove();
      sash.removeAttribute('data-dragging');
      commitWidth(last);
    };
    shield.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', up);
  };
  const onSashKey = (ev) => {
    const step = ev.shiftKey ? CREW_WIDTH.step * 4 : CREW_WIDTH.step;
    if (ev.key === 'ArrowLeft') commitWidth(widthRef.current + step);
    else if (ev.key === 'ArrowRight') commitWidth(widthRef.current - step);
    else if (ev.key === 'Home') commitWidth(CREW_WIDTH.default);
    else return;
    ev.preventDefault();
  };

  const pick = (key) => {
    const next = key === main.key ? '' : key;
    setChosen(next);
    writeChosen(folderKey, next || null);
    setMenuOpen(false);
    if (titleRef.current) titleRef.current.focus();
  };

  const toggleMenu = () => {
    setMenuOpen((o) => {
      if (!o) {
        loadRows();
        setActive(Math.max(0, sessions.findIndex((s) => s.key === slotKey)));
      }
      return !o;
    });
  };

  // Close the menu on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e) => {
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      if (titleRef.current && titleRef.current.contains(e.target)) return;
      setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [menuOpen]);
  useEffect(() => {
    if (menuOpen && menuRef.current) {
      const el = menuRef.current.querySelectorAll('[role="option"]')[active];
      if (el) el.focus();
    }
  }, [menuOpen, active, rows]);
  const onMenuKey = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      setMenuOpen(false);
      if (titleRef.current) titleRef.current.focus();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setActive((i) => Math.min(sessions.length - 1, i + 1));
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    }
  };

  const openInCrew = () => {
    const href = chatPageHref(slotKey);
    if (navigate) navigate(href);
    else window.location.assign(href);
  };

  const Panel = sdk.ChatPanel; // read at render: an older host has no ChatPanel
  let body;
  if (typeof Panel !== 'function' && !(Panel && typeof Panel === 'object')) {
    body = h('div', { className: 'vscp-crew-empty', 'data-testid': 'vscode-pane-crew-fallback' },
      h('div', null,
        h('div', { style: { marginBottom: 10 } }, 'This Kiro Crew does not provide the native chat panel to apps.'),
        h('button', { type: 'button', className: 'vscp-btn vscp-btn-primary', onClick: openInCrew, disabled: !slotKey }, 'Open in Kiro Crew')));
  } else if (!slotKey) {
    body = h('div', { className: 'vscp-crew-empty', 'data-testid': 'vscode-pane-crew-waiting' },
      main.folder ? "Opening the folder's Kiro Crew session..." : 'Open a folder in VS Code to chat with Kiro Crew about it.');
  } else {
    body = h(Panel, { key: slotKey, slotKey, conversationOnly: true });
  }

  const menu = menuOpen
    ? h('div', { ref: menuRef, className: 'vscp-crew-menu', role: 'listbox', 'aria-label': 'Kiro Crew sessions for this folder', tabIndex: -1, onKeyDown: onMenuKey, 'data-testid': 'vscode-pane-crew-menu' },
      rowsError && !rows ? h('div', { className: 'vscp-crew-menu-note' }, `Could not list sessions: ${rowsError}`) : null,
      ...sessions.map((s, i) =>
        h('button', {
          key: s.key, type: 'button', role: 'option', className: 'vscp-crew-item', tabIndex: i === active ? 0 : -1,
          'aria-selected': i === active ? 'true' : 'false', 'aria-current': s.key === slotKey ? 'true' : undefined,
          'data-slot': s.key, onClick: () => pick(s.key), onMouseEnter: () => setActive(i), title: s.key,
        },
        h('span', { className: 'vscp-dot', style: { background: s.running ? 'var(--vscp-ok)' : 'var(--vscp-border-strong)' } }),
        h('span', { className: 'vscp-truncate', style: { flex: '1 1 auto' } }, s.title),
        s.main ? h('span', { className: 'vscp-muted', style: { flex: 'none', fontSize: 11 } }, 'folder') : null)),
      sessions.length === 0 ? h('div', { className: 'vscp-crew-menu-note' }, 'No Kiro Crew sessions for this folder yet.') : null)
    : null;

  return h(React.Fragment, null,
    h('div', {
      ref: sashRef, className: 'vscp-sash', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the Kiro Crew chat',
      'aria-valuenow': width, 'aria-valuemin': CREW_WIDTH.min, tabIndex: 0, onPointerDown: onSashDown, onKeyDown: onSashKey,
      onDoubleClick: () => commitWidth(CREW_WIDTH.default), 'data-testid': 'vscode-pane-crew-sash',
    }),
    h('aside', {
      ref: colRef, className: 'vscp-crew', style: { width }, 'aria-label': 'Kiro Crew chat', 'data-testid': 'vscode-pane-crew',
      'data-slot': slotKey || '', 'data-vscp-kind': kind,
    },
    h('div', { className: 'vscp-crew-head', 'data-testid': 'vscode-pane-crew-header' },
      h(CrewIcon),
      h('button', {
        ref: titleRef, type: 'button', className: 'vscp-crew-title', onClick: toggleMenu, 'aria-haspopup': 'listbox', 'aria-expanded': menuOpen ? 'true' : 'false',
        title: `${title} (switch session)`, 'data-testid': 'vscode-pane-crew-switcher',
      },
      h('span', { className: 'vscp-truncate' }, title),
      h('span', { style: { flex: 'none', display: 'grid', color: 'var(--vscp-muted)' } }, svg(ICON_CHEVRON))),
      h('button', { type: 'button', className: 'vscp-crew-act', onClick: openInCrew, disabled: !slotKey, title: 'Open in Kiro Crew', 'aria-label': 'Open in Kiro Crew', 'data-testid': 'vscode-pane-crew-open' }, svg(ICON_EXTERNAL)),
      h('button', { type: 'button', className: 'vscp-crew-act', onClick: onCollapse, title: 'Hide the Kiro Crew chat (Ctrl+Alt+K in VS Code)', 'aria-label': 'Hide the Kiro Crew chat', 'data-testid': 'vscode-pane-crew-collapse' }, svg(ICON_CLOSE_PANEL)),
      menu),
    h('div', { className: 'vscp-crew-body', 'data-testid': 'vscode-pane-crew-body' }, body)));
}
