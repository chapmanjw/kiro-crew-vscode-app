// One VS Code chat request -> one Kiro Crew chat turn.
//
// The bridge extension POSTs the prompt to the launcher (/api/bridge/chat).
// The launcher finds or creates the Kiro Crew chat slot for the workspace
// folder, sends the turn with its app token, and writes newline-delimited JSON
// parts back while the gateway streams. When the extension cancels (VS Code's
// stop button closes the request), the turn is stopped in Kiro Crew too.

import path from 'node:path';
import { TurnRenderer } from './gateway.mjs';

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
    const r = await gateway.sendTurn({
      slot,
      message: prompt,
      signal,
      onRow: (row) => {
        for (const part of renderer.push(row)) write(part);
      },
    });
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
