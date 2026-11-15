// Pure helpers for the docked Kiro Crew chat column (ui/vscode-pane-crew-*.mjs).
// No React and no DOM access at import time, so node:test can load this file.

/**
 * Column geometry, in CSS px. The default matches R3's plan; the minimum keeps
 * ChatPage's composer footer (model, agent, project and app chips) on one row;
 * VS Code always keeps at least FRAME_MIN.
 */
export const CREW_WIDTH = Object.freeze({ default: 420, min: 360, frameMin: 320, sash: 4, step: 16 });
/** Height of the column header, the same as VS Code's side-bar title (35px). */
export const CREW_HEADER_HEIGHT = 35;

export const STORE_KEYS = Object.freeze({
  open: 'kc:vscode-pane:crew-open',
  width: 'kc:vscode-pane:crew-width',
  slot: 'kc:vscode-pane:crew-slot',
});

/**
 * Clamp a wanted column width to what the card can hold: at least
 * CREW_WIDTH.min, and VS Code keeps CREW_WIDTH.frameMin plus the sash. When the
 * card is too narrow for both minimums the column still gets its minimum.
 */
export function clampCrewWidth(want, cardWidth) {
  const w = Number.isFinite(want) ? Math.round(want) : CREW_WIDTH.default;
  const max = Number.isFinite(cardWidth) && cardWidth > 0 ? Math.floor(cardWidth - CREW_WIDTH.frameMin - CREW_WIDTH.sash) : Infinity;
  return Math.max(CREW_WIDTH.min, Math.min(w, max));
}

/** A stored width string back to a number, or the default. */
export function parseStoredWidth(raw) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n >= CREW_WIDTH.min && n <= 4000 ? n : CREW_WIDTH.default;
}

/** A stored open flag: open unless the user closed it ('0'). */
export function parseStoredOpen(raw) {
  return raw !== '0';
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
 * `crewSlotKey` string and `chatSlot: {key}` (R3's plan) are read too, so the
 * page works whichever the backend ships. Returns null when none is given.
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

/** The toggle counter on GET /api/session (bumped by VS Code's kiroCrew.toggleCrewChat), or null. */
export function toggleCounter(session) {
  const n = session && session.crewChatToggle;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Decide whether a new counter reading toggles the column. `seen` is the last
 * reading ({instance, count}) or null. The first reading of a launcher run is a
 * baseline (opening the page must not replay old presses), a counter that went
 * down means a new run, and each step up is one press: an odd number of
 * presses between two polls toggles, an even number cancels out.
 */
export function counterStep(seen, instance, count) {
  if (count === null || count === undefined) return { toggle: false, seen };
  const inst = instance || '';
  if (!seen || seen.instance !== inst || count < seen.count) return { toggle: false, seen: { instance: inst, count } };
  const presses = count - seen.count;
  return { toggle: presses % 2 === 1, presses, seen: { instance: inst, count } };
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

/**
 * The clip radii for the VS Code frame: with the column docked on the right,
 * only the card's bottom-left corner belongs to the frame.
 */
export function frameRadii(inner, columnOpen) {
  return columnOpen ? [0, 0, 0, inner] : [0, 0, inner, inner];
}
