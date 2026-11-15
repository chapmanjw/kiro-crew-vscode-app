// The VS Code frame's origin across launcher restarts.
//
// VS Code in the browser keeps everything per origin: user settings, the
// layout, open editors, recently opened, and its workspace storage, whose key
// also includes the remote authority (127.0.0.1:<port>) of the folder URI.
// The gateway gives the launcher a new PORT on every start (backend.port is
// "auto"), so the workbench is served from its own listener whose port is kept
// in data/state/frame.json. On the next start the launcher binds the same port
// again; if something else holds it, it picks a free one and records that.
//
// Only the port is kept. The path key that guards the frame is new on every
// launcher run and never written to disk: data/ is readable by Kiro Crew
// agents, and the key plus the port would open the workbench and its
// terminals without any approval. A new key per run also gives the page a new
// frame URL after a restart, so a kept-alive frame reloads on its own instead
// of holding a workbench whose connection token is gone.

import crypto from 'node:crypto';

/** Parse frame.json text; anything unusable yields {}. A legacy `key` is ignored. */
export function parseFrameState(text) {
  try {
    const v = JSON.parse(text);
    const out = {};
    if (v && typeof v === 'object' && Number.isInteger(v.port) && v.port >= 1024 && v.port <= 65535) out.port = v.port;
    return out;
  } catch {
    return {};
  }
}

/** True when the file on disk still carries a path key from an older version. */
export function frameStateHasKey(text) {
  try {
    const v = JSON.parse(text);
    return !!(v && typeof v === 'object' && 'key' in v);
  } catch {
    return false;
  }
}

/** The state to use now: a new key for this run and the preferred port (or 0). */
export function frameStateFor(saved, { randomKey = () => crypto.randomBytes(18).toString('base64url') } = {}) {
  return { key: randomKey(), port: saved.port || 0 };
}

/** What goes to disk: the port only. */
export function serializeFrameState({ port }) {
  return JSON.stringify({ port }, null, 2) + '\n';
}
