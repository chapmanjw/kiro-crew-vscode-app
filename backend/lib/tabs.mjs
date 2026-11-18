// The page's tabs (backend/launcher.mjs, ui/vscode-pane-*.mjs). Each tab is one
// VS Code window on a folder, served by the one VS Code server. A tab opened
// from a Kiro Crew chat (the composer's VS Code chip) is bound to that chat's
// session: its "Kiro Crew" view shows that session, and the chip brings the
// same tab back instead of opening another. A tab opened any other way shows
// the session list there. The tabs are kept in data/state/tabs.json, so they
// survive page reloads and launcher restarts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** A tab id: `t` and 12 lower-case hex digits. */
export const TAB_ID_RE = /^t[0-9a-f]{12}$/;
/**
 * A session slot name, as the dashboard and its embed name a chat (`chat-1763…`,
 * `vscode-my-app-…`). A key that arrives as `dashboard:<slot>` is stored as <slot>
 * (see slotOf).
 */
export const SESSION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** Each tab that has been shown runs a VS Code window and its extension host. */
export const MAX_TABS = 20;

export function newTabId() {
  return `t${crypto.randomBytes(6).toString('hex')}`;
}

export function validTabId(v) {
  return typeof v === 'string' && TAB_ID_RE.test(v) ? v : null;
}

/**
 * The slot name of a session key. The dashboard drops one `dashboard:` prefix, then
 * any `dashboard_` prefixes (its Du function in the bundle), so `dashboard:chat-1` is
 * `chat-1`. The embed's URL and the tab store use the slot name only.
 */
export function slotOf(key) {
  let t = String(key ?? '');
  if (t.startsWith('dashboard:')) t = t.slice('dashboard:'.length);
  while (t.startsWith('dashboard_')) t = t.slice('dashboard_'.length);
  return t;
}

/** The slot name of a session key when it is a valid one, else null. */
export function validSessionKey(v) {
  if (typeof v !== 'string') return null;
  const slot = slotOf(v);
  return SESSION_KEY_RE.test(slot) ? slot : null;
}

/** An absolute folder path of at most 4096 characters with no NUL, trimmed; null otherwise. */
export function validFolder(v, isAbsolute = path.isAbsolute) {
  if (typeof v !== 'string') return null;
  const f = v.trim();
  if (!f || f.length > 4096 || f.includes('\0') || !isAbsolute(f)) return null;
  return f;
}

/** Whether two folder paths name the same folder (trailing separators ignored; case-insensitive on Windows). */
export function sameFolder(a, b, { win = process.platform === 'win32' } = {}) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const P = win ? path.win32 : path.posix;
  const norm = (p) => {
    const r = P.resolve(p);
    const t = r.length > P.parse(r).root.length ? r.replace(/[\\/]+$/, '') : r;
    return win ? t.toLowerCase() : t;
  };
  return norm(a) === norm(b);
}

const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * The tabs in data/state/tabs.json: `{tabs, active}`, or null when the text is
 * not a tab file. Entries with a bad id, a duplicate id or no folder are dropped.
 */
export function parseTabs(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || !Array.isArray(v.tabs)) return null;
  const seen = new Set();
  const tabs = [];
  for (const t of v.tabs) {
    if (tabs.length >= MAX_TABS) break;
    if (!t || typeof t !== 'object' || !validTabId(t.id) || seen.has(t.id)) continue;
    if (typeof t.folder !== 'string' || !t.folder || t.folder.length > 4096 || t.folder.includes('\0')) continue;
    seen.add(t.id);
    tabs.push({ id: t.id, folder: t.folder, session: validSessionKey(t.session), createdAt: num(t.createdAt), activeAt: num(t.activeAt) });
  }
  const active = typeof v.active === 'string' && seen.has(v.active) ? v.active : tabs.length ? tabs[0].id : null;
  return { tabs, active };
}

export class TabStore {
  /**
   * @param {object} o
   * @param {string} o.file  data/state/tabs.json
   * @param {() => number} [o.now]
   * @param {() => string} [o.newId]
   * @param {(e: Error) => void} [o.onError]  a failed save (the tabs stay in memory)
   */
  constructor({ file, now = () => Date.now(), newId = newTabId, onError = () => {} }) {
    this.file = file;
    this.now = now;
    this.newId = newId;
    this.onError = onError;
    let text = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      text = null;
    }
    const parsed = text === null ? null : parseTabs(text);
    // No file yet: the page opens the first tab itself, on the folder it used last.
    this.fresh = text === null;
    this.tabs = parsed ? parsed.tabs : [];
    this.active = parsed ? parsed.active : null;
  }

  list() {
    return this.tabs.map((t) => ({ ...t }));
  }

  get(id) {
    return this.tabs.find((t) => t.id === id) || null;
  }

  bySession(key) {
    const k = validSessionKey(key);
    return (k && this.tabs.find((t) => t.session === k)) || null;
  }

  /**
   * Open a tab and bring it to the front. A session already open in a tab gets
   * that tab back, wherever its folder now is. With `reuse`, a tab on the same
   * folder that is not bound to a session is reused. Otherwise a new tab is added
   * at the end. Returns `{tab, created}`, or `{error, status}` when too many are open.
   */
  open({ folder, session = null, reuse = false }) {
    session = validSessionKey(session);
    const existing = session ? this.bySession(session) : reuse ? this.tabs.find((t) => !t.session && sameFolder(t.folder, folder)) : null;
    if (existing) {
      this.activate(existing.id);
      return { tab: { ...existing }, created: false };
    }
    if (this.tabs.length >= MAX_TABS) return { error: `at most ${MAX_TABS} VS Code tabs can be open; close one first`, status: 409 };
    const at = this.now();
    let id = this.newId();
    while (this.get(id)) id = this.newId();
    const tab = { id, folder, session: session || null, createdAt: at, activeAt: at };
    this.tabs.push(tab);
    this.active = id;
    this.save();
    return { tab: { ...tab }, created: true };
  }

  activate(id) {
    const t = this.get(id);
    if (!t) return false;
    t.activeAt = this.now();
    this.active = id;
    this.save();
    return true;
  }

  /** Close a tab. When it was the front tab, the one to its right takes its place, else the one to its left. */
  close(id) {
    const i = this.tabs.findIndex((t) => t.id === id);
    if (i < 0) return false;
    this.tabs.splice(i, 1);
    if (this.active === id) {
      const next = this.tabs[i] || this.tabs[i - 1] || null;
      this.active = next ? next.id : null;
      if (next) next.activeAt = this.now();
    }
    this.save();
    return true;
  }

  /** The window opened another folder itself (File > Open Folder in VS Code): the tab follows it. */
  setFolder(id, folder) {
    const t = this.get(id);
    if (!t || typeof folder !== 'string' || !folder || t.folder === folder) return false;
    t.folder = folder;
    this.save();
    return true;
  }

  /** The tab most recently brought to the front among `pred`, or null. */
  recent(pred = () => true) {
    let best = null;
    for (const t of this.tabs) if (pred(t) && (!best || t.activeAt > best.activeAt)) best = t;
    return best;
  }

  save() {
    this.fresh = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ tabs: this.tabs, active: this.active }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      this.onError(e);
    }
  }
}
