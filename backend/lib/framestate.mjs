// A stable origin and path for the VS Code frame across launcher restarts.
//
// VS Code in the browser keeps everything per origin: user settings, the
// layout, open editors, recently opened, and its workspace storage, whose key
// also includes the remote authority (127.0.0.1:<port>) of the folder URI.
// The gateway gives the launcher a new PORT on every start (backend.port is
// "auto"), and V1 made a new frame key per run, so each restart looked like a
// brand new browser to VS Code and the pane "started over".
//
// The frame is therefore served from its own listener whose port is kept in
// data/state/frame.json together with the path key. On the next start the
// launcher binds the same port again; if something else holds it, it picks a
// free one and records that instead.

import crypto from 'node:crypto';

const KEY_RE = /^[A-Za-z0-9_-]{24,64}$/;

/** Parse frame.json text; anything unusable yields {}. */
export function parseFrameState(text) {
  try {
    const v = JSON.parse(text);
    const out = {};
    if (v && typeof v === 'object') {
      if (Number.isInteger(v.port) && v.port >= 1024 && v.port <= 65535) out.port = v.port;
      if (typeof v.key === 'string' && KEY_RE.test(v.key)) out.key = v.key;
    }
    return out;
  } catch {
    return {};
  }
}

/** The state to use now: the saved key (or a new one) and the preferred port (or 0). */
export function frameStateFor(saved, { randomKey = () => crypto.randomBytes(18).toString('base64url') } = {}) {
  return { key: saved.key || randomKey(), port: saved.port || 0 };
}

export function serializeFrameState({ key, port }) {
  return JSON.stringify({ key, port }, null, 2) + '\n';
}
