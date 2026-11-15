// One VS Code chat request -> one Kiro Crew chat turn.
//
// The bridge extension POSTs the prompt to the launcher (/api/bridge/chat).
// The launcher finds or creates the Kiro Crew chat slot for the workspace
// folder, sends the turn with its app token, and writes newline-delimited JSON
// parts back while the gateway streams. When the extension cancels (VS Code's
// stop button closes the request), the turn is stopped in Kiro Crew too.

import path from 'node:path';
import { TurnRenderer, isSlotGone } from './gateway.mjs';
import { NativeTurnRenderer, TurnWatcher, reconcileTools, approvalStateIn, APPROVE_IN_KIRO_CREW } from './nativechat.mjs';

export const MAX_PROMPT = 40_000; // the gateway's own message_length_limit default

/** Validate the extension's request body. */
export function parseChatRequest(body, { defaultFolder } = {}) {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) return { error: 'prompt is required' };
  if (prompt.length > MAX_PROMPT) return { error: `prompt over ${MAX_PROMPT} characters` };
  let folder = body.folder == null || body.folder === '' ? defaultFolder : body.folder;
  if (typeof folder !== 'string' || !folder || folder.length > 4096 || folder.includes('\0') || !path.isAbsolute(folder)) {
    return { error: 'folder must be an absolute path' };
  }
  return { prompt, folder };
}

/**
 * True when `folder` is one of the workspace folders the extension host
 * reported, or inside one. Chat runs a full Kiro Crew turn in the folder, so
 * the bridge may only name a folder this VS Code window has open. Windows
 * paths compare case-insensitively.
 */
export function folderInRoots(folder, roots, { win = process.platform === 'win32' } = {}) {
  if (typeof folder !== 'string' || !Array.isArray(roots) || !roots.length) return false;
  const P = win ? path.win32 : path.posix;
  const norm = (p) => {
    const r = P.resolve(String(p));
    const trimmed = r.length > P.parse(r).root.length ? r.replace(/[\\/]+$/, '') : r;
    return win ? trimmed.toLowerCase() : trimmed;
  };
  const f = norm(folder);
  return roots.some((root) => {
    if (typeof root !== 'string' || !root) return false;
    const r = norm(root);
    if (f === r) return true;
    const prefix = r.endsWith(P.sep) ? r : r + P.sep;
    return f.startsWith(prefix);
  });
}

/**
 * Run one turn.
 * @param {{gateway:import('./gateway.mjs').GatewayClient, prompt:string, folder:string,
 *          signal:AbortSignal, write:(part:object)=>void, log?:Function}} o
 * @returns {Promise<{outcome:'done'|'queued'|'cancelled'|'error'|'incomplete', slot?:string, error?:string}>}
 */
export async function runChatTurn({ gateway, prompt, folder, signal, write, log = () => {} }) {
  let slot;
  try {
    slot = await gateway.ensureSlot(folder);
    write({ kind: 'session', slot });
    const renderer = new TurnRenderer();
    const send = () =>
      gateway.sendTurn({
        slot,
        message: prompt,
        signal,
        onRow: (row) => {
          for (const part of renderer.push(row)) write(part);
        },
      });
    let r;
    try {
      r = await send();
    } catch (e) {
      // The slot was closed or removed between the create and the send:
      // recreate it once (with its project) and send again.
      if (signal?.aborted || !isSlotGone(e)) throw e;
      log('chat: slot gone, recreating', slot, e.message);
      slot = await gateway.ensureSlot(folder);
      r = await send();
    }
    if (r.queued) {
      write({
        kind: 'warning',
        text: 'Kiro Crew is still working on an earlier turn in this session; your message is queued there and its reply will show in the Kiro Crew session.',
      });
      write({ kind: 'done', slot, queued: true });
      return { outcome: 'queued', slot };
    }
    write({ kind: 'done', slot, complete: r.done });
    return { outcome: r.done ? 'done' : 'incomplete', slot };
  } catch (e) {
    if (signal?.aborted || e.name === 'AbortError') {
      if (slot) {
        try {
          await gateway.stop(slot);
        } catch (err) {
          log('chat: stop after cancel failed', err.message);
        }
      }
      return { outcome: 'cancelled', slot };
    }
    write({ kind: 'error', text: e.message });
    return { outcome: 'error', slot, error: e.message };
  }
}

/** Validate a native session turn: the 0.3.1 body plus the session's slot. */
export function parseNativeChatRequest(body, opts) {
  const base = parseChatRequest(body, opts);
  if (base.error) return base;
  const slot = typeof body.slot === 'string' ? body.slot : '';
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(slot)) return { error: 'slot is required' };
  return { ...base, slot, title: typeof body.title === 'string' ? body.title.slice(0, 200) : '' };
}

/**
 * Run one turn of a Kiro Crew chat session type session: the slot is the
 * session's own (one slot per VS Code chat session), and rows go out as
 * structured parts for native tool cards and approval cards. While the turn
 * waits on an approval or a question a TurnWatcher polls the slot, so a
 * decision made in Kiro Crew clears the VS Code card. At the end the tool
 * cards are completed from the persisted rows (kind, input, output).
 * @param {{gateway:import('./gateway.mjs').GatewayClient, prompt:string, folder:string, slot:string,
 *          title?:string, signal:AbortSignal, write:(part:object)=>void, log?:Function, watchMs?:number}} o
 */
export async function runNativeTurn({ gateway, prompt, folder, slot, title, signal, write, log = () => {}, watchMs = 1000 }) {
  const renderer = new NativeTurnRenderer();
  let watcher = null;
  let questionsOn = false;
  const startWatch = () => {
    if (!watcher) {
      watcher = new TurnWatcher({ gateway, slot, renderer, write, intervalMs: watchMs, questionsEnabled: () => questionsOn, log });
      watcher.start();
    }
  };
  try {
    // Recreated on every turn, as for the folder slot: the session can be
    // closed or deleted in Kiro Crew at any time. The create is a no-op for an
    // open slot.
    const ensure = () => gateway.ensureSlotNamed({ name: slot, title: title || 'VS Code chat', folder });
    await ensure();
    write({ kind: 'session', slot, native: true });
    // Questions are read only with the approval grant; probing it once here
    // also lets the first approval card say at once when VS Code cannot answer.
    const grant = await gateway.approvalGrantFor(slot, { maxAgeMs: 0 }).catch(() => null);
    questionsOn = !!(grant && grant.granted);
    if (questionsOn) startWatch();
    const onRow = (row) => {
      for (const part of renderer.push(row)) {
        if (part.kind === 'approval') {
          const g = gateway.approvalGrant;
          part.grant = g && g.granted === false ? { granted: false, cause: g.cause || '', message: g.message || APPROVE_IN_KIRO_CREW } : { granted: true };
          if (!part.requestId) part.grant = { granted: false, cause: 'no_request_id', message: 'This approval carries no request id; approve or reject it in the Kiro Crew session.' };
          startWatch();
        }
        write(part);
      }
    };
    const send = () => gateway.sendTurn({ slot, message: prompt, signal, onRow });
    let r;
    try {
      r = await send();
    } catch (e) {
      if (signal?.aborted || !isSlotGone(e)) throw e;
      log('chat: session slot gone, recreating', slot, e.message);
      await ensure();
      r = await send();
    }
    watcher?.stop();
    if (r.queued) {
      write({ kind: 'warning', text: 'Kiro Crew is still working on an earlier turn in this session; your message is queued there and its reply will show in the Kiro Crew session.' });
      write({ kind: 'done', slot, queued: true });
      return { outcome: 'queued', slot };
    }
    // One read of the persisted rows completes the tool cards and tells how
    // approvals the stream never resolved were decided.
    let rows = null;
    if (renderer.tools.length || renderer.pendingIds().length) {
      try {
        rows = (await gateway.slotDetail(slot, 200))?.messages || null;
      } catch (e) {
        log('chat: turn-end read failed', e.message);
      }
    }
    for (const id of renderer.pendingIds()) {
      const st = approvalStateIn(rows, id);
      for (const p of renderer.resolve(id, (st && st.resolved) || 'ended')) write(p);
    }
    for (const p of watcher ? watcher.finish() : []) write(p);
    if (renderer.tools.length) for (const p of reconcileTools(renderer.tools, rows || [])) write(p);
    write({ kind: 'done', slot, complete: r.done });
    return { outcome: r.done ? 'done' : 'incomplete', slot, tools: renderer.tools.length };
  } catch (e) {
    watcher?.stop();
    if (signal?.aborted || e.name === 'AbortError') {
      try {
        await gateway.stop(slot);
      } catch (err) {
        log('chat: stop after cancel failed', err.message);
      }
      return { outcome: 'cancelled', slot };
    }
    write({ kind: 'error', text: e.message });
    return { outcome: 'error', slot, error: e.message };
  }
}
