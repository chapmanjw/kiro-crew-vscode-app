// Pure helpers for the Kiro Crew chat the page draws over VS Code's "Kiro
// Crew" view (ui/vscode-pane-crew-*.mjs). No React and no DOM access at import
// time, so node:test can load this file.

/** Height of the slim header the page draws at the top of the view (session switcher, Open in Kiro Crew). */
export const CREW_HEADER_HEIGHT = 30;

export const STORE_KEYS = Object.freeze({
  slot: 'kc:vscode-pane:crew-slot',
});

/**
 * The composer chip this app contributes (app.json contributes.sessionControls[0].icon).
 * The host renders it as a lucide icon whose <svg> carries `lucide-<name>`
 * (components/AppIcon.tsx ICON_MAP; lucide-react adds the class), which is the
 * only stable mark the chip has besides its label.
 */
export const CHIP_ICON = 'Package';

/**
 * CSS that hides this app's own composer chip inside `scope` (the overlay's
 * root) and nowhere else. Kiro Crew gives an app no supported way to hide its
 * session control per surface (README, VS Code chip), so this matches the
 * chip by `data-session-control-chip` plus its icon class, never by text, and
 * also hides the chip row's wrapper when ours was its only chip, so no empty
 * divider is left behind.
 */
export function chipHideCss(scope, icon = CHIP_ICON) {
  if (!/^[.#][A-Za-z0-9_-]+$/.test(scope)) throw new Error('scope must be one class or id selector');
  const cls = `lucide-${String(icon).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
  const chip = `button[data-session-control-chip]:has(svg.${cls})`;
  const other = `button[data-session-control-chip]:not(:has(svg.${cls}))`;
  return `${scope} ${chip}{display:none !important}\n${scope} div:has(> ${chip}):not(:has(> ${other})){display:none !important}`;
}

/** Folder paths compared the way the launcher's slot names treat them. */
export function normFolder(p, platform = 'win32') {
  const s = String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? s.toLowerCase() : s;
}

export function folderBase(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** The title the launcher gives the folder's main session ("VS Code: <folder name>"). */
export function mainSlotTitle(folder) {
  return `VS Code: ${folderBase(folder) || folder || 'workspace'}`;
}

/**
 * The folder's crew slot as the launcher reports it on GET /api/session.
 * `crewSlot: {key, folder?, title?}` is the contract name; a bare
 * `crewSlotKey` string and `chatSlot: {key}` are read too. Returns null when
 * none is given.
 */
export function crewSlotFromSession(session) {
  if (!session || typeof session !== 'object') return null;
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  const c = session.crewSlot;
  if (c && typeof c === 'object' && pick(c.key)) return { key: pick(c.key), folder: pick(c.folder) || session.folder || '', title: pick(c.title) };
  if (pick(c)) return { key: pick(c), folder: session.folder || '', title: '' };
  if (pick(session.crewSlotKey)) return { key: pick(session.crewSlotKey), folder: session.folder || '', title: '' };
  const k = session.chatSlot;
  if (k && typeof k === 'object' && pick(k.key)) return { key: pick(k.key), folder: pick(k.folder) || session.folder || '', title: pick(k.title) };
  return null;
}

/**
 * The sessions the switcher lists: Kiro Crew slots whose project (or
 * workspace) is this folder, the folder's main slot first, then most recent
 * activity first. The main slot is listed even before the gateway reports it.
 */
export function crewSessionsForFolder(slots, folder, mainKey, platform = 'win32') {
  const want = normFolder(folder, platform);
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(slots) ? slots : []) {
    if (!s || typeof s.key !== 'string' || !s.key || seen.has(s.key)) continue;
    const p = normFolder(s.project || s.workspace || '', platform);
    if (s.key !== mainKey && (!want || p !== want)) continue;
    seen.add(s.key);
    out.push({
      key: s.key,
      title: (typeof s.title === 'string' && s.title.trim()) || s.key,
      running: !!s.running,
      last: Date.parse(s.last_ts || s.last_turn_ts || s.created || '') || 0,
      main: s.key === mainKey,
    });
  }
  if (mainKey && !seen.has(mainKey)) out.push({ key: mainKey, title: mainSlotTitle(folder), running: false, last: 0, main: true });
  out.sort((a, b) => (a.main !== b.main ? (a.main ? -1 : 1) : b.last - a.last || a.title.localeCompare(b.title)));
  return out;
}

/** The Kiro Crew Chat page for a session (App.tsx `/chat/:slug?`). */
export function chatPageHref(slotKey) {
  return slotKey ? `/chat/${encodeURIComponent(slotKey)}` : '/chat';
}

// ---------------------------------------------------------------------------
// The view report from the workbench (backend/lib/view-overlay.js)
// ---------------------------------------------------------------------------

/** A per-run nonce for the frame's messages (hex, 32 chars). */
export function newNonce(cryptoObj = globalThis.crypto) {
  const b = new Uint8Array(16);
  cryptoObj.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** The origin of the frame URL (`http://127.0.0.1:<port>`), or ''. */
export function frameOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

const OVERLAY_NAMES = new Set(['quickInput', 'contextView', 'dialog', 'notification', 'notificationCenter', 'hover', 'menu']);
const LOCATIONS = new Set(['auxiliarybar', 'sidebar', 'panel', 'editor', 'other', 'unknown', 'none']);
const num = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Accept a message only from the VS Code frame: the frame's own origin, its
 * contentWindow as the source and this run's nonce. Returns a normalised
 * report, or null for anything else (wrong origin, wrong window, wrong or
 * missing nonce, malformed).
 */
export function acceptViewMessage(event, { origin, source, nonce }) {
  if (!event || !origin || !source || !nonce) return null;
  if (event.origin !== origin || event.source !== source) return null;
  const d = event.data;
  if (!d || typeof d !== 'object' || d.type !== 'kc-view' || d.nonce !== nonce) return null;
  const v = d.view && typeof d.view === 'object' ? d.view : {};
  const r = v.rect && typeof v.rect === 'object' ? v.rect : null;
  const rect = r && [r.x, r.y, r.width, r.height].every(num) && r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  const vp = d.viewport && typeof d.viewport === 'object' && num(d.viewport.w) && num(d.viewport.h) && d.viewport.w > 0 && d.viewport.h > 0 ? { w: d.viewport.w, h: d.viewport.h } : null;
  return {
    seq: Number.isInteger(d.seq) ? d.seq : 0,
    view: {
      found: v.found === true,
      visible: v.visible === true && !!rect,
      rect,
      location: LOCATIONS.has(v.location) ? v.location : 'unknown',
      focused: v.focused === true,
    },
    blocked: Array.isArray(d.blocked) ? d.blocked.filter((b) => OVERLAY_NAMES.has(b)) : [],
    dragging: d.dragging === true,
    hidden: d.hidden === true,
    viewport: vp,
  };
}

/** The 'kc-view-ready' ping the frame sends on load (no data); same origin and source rules, no nonce. */
export function isReadyMessage(event, { origin, source }) {
  return !!event && !!origin && event.origin === origin && event.source === source && !!event.data && event.data.type === 'kc-view-ready';
}

/** Why the overlay is hidden for a report, or '' when it may show. */
export function hiddenReason(report) {
  if (!report) return 'no report';
  if (report.hidden) return 'document hidden';
  if (!report.view.found) return 'view not created';
  if (!report.view.visible) return 'view hidden';
  if (report.dragging) return 'drag';
  if (report.blocked.length) return `covered by ${report.blocked.join(', ')}`;
  return '';
}

/**
 * Where the overlay goes in the dashboard's viewport: the reported rect
 * (frame viewport px) mapped through the iframe's box, scaled by the iframe's
 * size over the frame's own viewport (CSS zoom or transforms on the way), and
 * clipped to `bounds` (the part of the page the frame may paint, <main>).
 * Returns {left, top, width, height, clip} or null when nothing is left.
 */
export function overlayPlacement(rect, viewport, iframeBox, bounds) {
  if (!rect || !iframeBox || iframeBox.width <= 0 || iframeBox.height <= 0) return null;
  const sx = viewport && viewport.w > 0 ? iframeBox.width / viewport.w : 1;
  const sy = viewport && viewport.h > 0 ? iframeBox.height / viewport.h : 1;
  const left = iframeBox.left + rect.x * sx;
  const top = iframeBox.top + rect.y * sy;
  const width = rect.width * sx;
  const height = rect.height * sy;
  const b = bounds || iframeBox;
  // Clip to both the iframe (VS Code's own viewport) and the bounds.
  const cl = Math.max(left, iframeBox.left, b.left);
  const ct = Math.max(top, iframeBox.top, b.top);
  const cr = Math.min(left + width, iframeBox.left + iframeBox.width, b.left + b.width);
  const cb = Math.min(top + height, iframeBox.top + iframeBox.height, b.top + b.height);
  if (cr - cl < 1 || cb - ct < 1) return null;
  const r = (n) => Math.round(n * 100) / 100;
  return {
    left: r(left),
    top: r(top),
    width: r(width),
    height: r(height),
    clip: `inset(${r(ct - top)}px ${r(left + width - cr)}px ${r(top + height - cb)}px ${r(cl - left)}px)`,
  };
}

/**
 * Whether a keydown in the overlay is a VS Code shortcut to forward to the
 * workbench: F1-F12 alone, or a chord with Ctrl, Alt or Meta that is not text
 * editing (copy, cut, paste, select all, undo, redo, word moves and deletes,
 * Enter to send). Only when the chat did not handle it itself.
 */
export function shouldForwardKey(e) {
  if (!e || e.defaultPrevented || e.isComposing) return false;
  const key = String(e.key || '');
  if (/^F([1-9]|1[0-2])$/.test(key) && !e.ctrlKey && !e.altKey && !e.metaKey) return true;
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return false;
  if (['Control', 'Alt', 'Meta', 'Shift', 'AltGraph'].includes(key)) return false;
  // AltGr types characters on many layouts (it arrives as Ctrl+Alt on Windows).
  if (e.ctrlKey && e.altKey && key.length === 1 && typeof e.getModifierState === 'function' && e.getModifierState('AltGraph')) return false;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.altKey) {
    const k = key.toLowerCase();
    if (['a', 'c', 'v', 'x', 'z', 'y'].includes(k)) return false;
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'backspace', 'delete', 'home', 'end', 'enter'].includes(k)) return false;
  }
  if (e.altKey && !mod && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'].includes(key)) return false;
  return true;
}

/** The fields of a keydown the frame needs to replay it (backend/lib/view-overlay.js kc-view-key). */
export function keyPayload(e) {
  return { key: e.key, code: e.code, keyCode: e.keyCode || 0, ctrlKey: !!e.ctrlKey, shiftKey: !!e.shiftKey, altKey: !!e.altKey, metaKey: !!e.metaKey };
}
