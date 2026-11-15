// Native VS Code Chat sessions backed by Kiro Crew chat slots.
//
// The bridge extension registers a "Kiro Crew" chat session type (proposed
// API chatSessionsProvider). Each VS Code chat session is one Kiro Crew slot.
// This module holds the launcher side of that:
//   - NativeTurnRenderer: gateway slot rows -> structured parts (markdown,
//     thinking, tool cards, approvals) instead of the flattened text the
//     0.3.1 participant shows.
//   - reconcileTools: the turn's SSE stream carries a tool row's title only;
//     its kind, input, output and completion are written to the persisted row
//     (KiroCrew chat_turn/tool_rows.py _tool_meta, chat_turn/tool_results.py),
//     which GET /api/chat/slots/{slot} returns. At turn end the live cards are
//     completed from those rows.
//   - historyTurns: slot detail rows -> request/response turns for
//     provideChatSessionContent.
//   - TurnWatcher: while a turn waits on an approval or a question, polls the
//     slot so a decision made in Kiro Crew clears the VS Code card.
//   - SessionRegistry: which slots this app created for which folder, in
//     data/state/chat-sessions.json, so the session list survives reloads.

import fs from 'node:fs';
import crypto from 'node:crypto';
import { slotNameFor } from './gateway.mjs';

const MAX_TITLE = 80;
const MAX_FIELD = 16_000;

function parseMeta(row) {
  if (row && row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)) return row.meta;
  const cls = row ? row.cls : null;
  if (cls && typeof cls === 'object' && !Array.isArray(cls)) return cls;
  if (typeof cls !== 'string' || !cls.startsWith('{')) return null;
  try {
    const m = JSON.parse(cls);
    return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  } catch {
    return null;
  }
}

function text(v, max = MAX_FIELD) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** "🔧 Reading hello.txt" -> {title: "Reading hello.txt", failed: false}; "🚫 X (rejected)" -> failed. */
export function toolTitle(content) {
  const raw = String(content || '').replace(/\s+/g, ' ').trim();
  const failed = /^🚫/u.test(raw);
  const title = raw.replace(/^[\p{Extended_Pictographic}️\s]+/u, '').trim();
  return { title: title.slice(0, 300) || 'tool', failed };
}

/**
 * Slot rows -> native parts:
 *   {kind:'markdown', text} | {kind:'thinking', text}
 *   {kind:'tool', id, title, state:'running'|'done'|'error', toolKind?, input?, output?}
 *   {kind:'approval', requestId, title, toolKind, input, purpose, readOnly}
 *   {kind:'approvalResolved', requestId, resolved}
 *   {kind:'notice', text} | {kind:'warning', text}
 */
export class NativeTurnRenderer {
  constructor() {
    this.segment = '';
    this.wroteAny = false;
    this.tools = []; // [{id, title, state}] in arrival order
    this.pending = new Map(); // requestId -> approval part
    this.resolved = new Set();
  }

  push(row) {
    if (!row || typeof row !== 'object') return [];
    const type = typeof row.type === 'string' ? row.type : typeof row.role === 'string' ? row.role : '';
    const content = typeof row.content === 'string' ? row.content : '';
    switch (type) {
      case 'chunk':
        if (!content) return [];
        this.segment += content;
        this.wroteAny = true;
        return [{ kind: 'markdown', text: content }];
      case 'assistant': {
        const seg = this.segment;
        this.segment = '';
        if (!content) return [];
        let out;
        if (!seg) out = (this.wroteAny ? '\n\n' : '') + content;
        else if (content.startsWith(seg)) out = content.slice(seg.length);
        else out = '';
        if (!out) return [];
        this.wroteAny = true;
        return [{ kind: 'markdown', text: out }];
      }
      case 'thinking':
        return content ? [{ kind: 'thinking', text: content }] : [];
      case 'tool': {
        if (!content) return [];
        const { title, failed } = toolTitle(content);
        const part = { kind: 'tool', id: `kc-tool-${this.tools.length + 1}`, title, state: failed ? 'error' : 'running' };
        this.tools.push({ id: part.id, title, state: part.state });
        return [part];
      }
      case 'permission': {
        const meta = parseMeta(row) || {};
        const requestId = typeof meta.request_id === 'string' || typeof meta.request_id === 'number' ? String(meta.request_id) : null;
        if (meta.resolved) {
          if (requestId && this.pending.has(requestId)) return this.resolve(requestId, String(meta.resolved));
          return [];
        }
        if (requestId && (this.pending.has(requestId) || this.resolved.has(requestId))) return [];
        const part = {
          kind: 'approval',
          requestId,
          title: text(meta.tool_title || content || 'a tool call', 300),
          toolKind: text(meta.tool_kind || '', 64),
          input: text(meta.full_command || meta.tool_input || ''),
          purpose: text(meta.tool_purpose || '', 2000),
          readOnly: meta.is_read_only === true || meta.is_read_only === '1',
        };
        if (requestId) this.pending.set(requestId, part);
        return [part];
      }
      case 'error':
        return content ? [{ kind: 'warning', text: text(content, 500) }] : [];
      case 'notice':
      case 'system':
        return content ? [{ kind: 'notice', text: text(content, 500) }] : [];
      default:
        return [];
    }
  }

  /** Mark a pending approval as decided (here or in Kiro Crew). */
  resolve(requestId, resolved) {
    if (!this.pending.has(requestId)) return [];
    this.pending.delete(requestId);
    this.resolved.add(requestId);
    return [{ kind: 'approvalResolved', requestId, resolved }];
  }

  pendingIds() {
    return [...this.pending.keys()];
  }
}

/** Rows of the current turn: everything after the last user row. */
export function currentTurnRows(messages) {
  if (!Array.isArray(messages)) return [];
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = messages[i] && (messages[i].role || messages[i].type);
    if (role === 'user') {
      start = i + 1;
      break;
    }
  }
  return messages.slice(start);
}

function toolDetails(row) {
  const meta = parseMeta(row) || {};
  const { title, failed } = toolTitle(row.content);
  const errored = failed || meta.status === 'failed' || meta.error === true || meta.is_error === true;
  return {
    title,
    state: errored ? 'error' : 'done',
    toolKind: text(meta.kind || '', 64),
    input: text(meta.input || ''),
    output: text(meta.output || ''),
    toolCallId: typeof meta.tool_call_id === 'string' ? meta.tool_call_id : '',
  };
}

/**
 * Complete the live tool cards from the persisted rows of the turn. The SSE
 * stream gives each card in arrival order; the slot detail lists the same rows
 * in the same order, so they are matched by position. A card with no row left
 * is closed as done.
 */
export function reconcileTools(liveTools, messages) {
  const rows = currentTurnRows(messages).filter((m) => (m.role || m.type) === 'tool');
  return liveTools.map((t, i) => {
    const r = rows[i];
    if (!r) return { kind: 'tool', id: t.id, title: t.title, state: t.state === 'error' ? 'error' : 'done' };
    const d = toolDetails(r);
    return { kind: 'tool', id: t.id, title: t.title || d.title, state: t.state === 'error' ? 'error' : d.state, toolKind: d.toolKind, input: d.input, output: d.output };
  });
}

/**
 * Slot detail rows -> the session's history:
 *   [{role:'user', text}, {role:'assistant', parts:[markdown | tool]}]
 * Rows before the first user row (a greeting, notices) start an assistant turn
 * of their own only when they carry text.
 */
export function historyTurns(messages) {
  const turns = [];
  let cur = null;
  const assistant = () => {
    if (!cur) {
      cur = { role: 'assistant', parts: [] };
      turns.push(cur);
    }
    return cur;
  };
  let n = 0;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role || m.type;
    const content = typeof m.content === 'string' ? m.content : '';
    if (role === 'user') {
      cur = null;
      turns.push({ role: 'user', text: content });
      continue;
    }
    if ((role === 'assistant' || role === 'streaming') && content) {
      const a = assistant();
      const last = a.parts[a.parts.length - 1];
      if (last && last.kind === 'markdown') last.text += '\n\n' + content;
      else a.parts.push({ kind: 'markdown', text: content });
    } else if (role === 'tool' && content) {
      const d = toolDetails(m);
      assistant().parts.push({ kind: 'tool', id: d.toolCallId || `kc-hist-${++n}`, title: d.title, state: d.state, toolKind: d.toolKind, input: d.input, output: d.output });
    } else if (role === 'error' && content) {
      assistant().parts.push({ kind: 'markdown', text: `> **Kiro Crew:** ${text(content, 500)}` });
    }
  }
  return turns;
}

/** The pending permission row for `requestId` in slot detail rows, or its resolution. */
export function approvalStateIn(messages, requestId) {
  if (!Array.isArray(messages)) return null;
  let found = null;
  for (const m of messages) {
    if (!m || (m.role || m.type) !== 'permission') continue;
    const meta = parseMeta(m);
    if (!meta || String(meta.request_id) !== String(requestId)) continue;
    found = meta.resolved ? { resolved: String(meta.resolved) } : found || { resolved: null };
    if (meta.resolved) return found;
  }
  return found;
}

/** Normalise the gateway's question cards to {askId, questions:[{question, header, options:[label]}]}. */
export function normalizeQuestions(pending) {
  const out = [];
  for (const card of Array.isArray(pending) ? pending : []) {
    if (!card || typeof card.ask_id !== 'string' || !card.ask_id) continue; // native mid-turn cards are answered in Kiro Crew
    const questions = [];
    for (const q of Array.isArray(card.questions) ? card.questions : []) {
      if (!q || typeof q.question !== 'string') continue;
      const options = (Array.isArray(q.options) ? q.options : [])
        .map((o) => (typeof o === 'string' ? o : o && typeof o.label === 'string' ? o.label : ''))
        .filter(Boolean)
        .slice(0, 6);
      questions.push({ question: text(q.question, 500), header: text(q.header || '', 50), options, multiSelect: q.multiSelect === true });
    }
    if (questions.length) out.push({ askId: card.ask_id, questions });
  }
  return out;
}

/** The gateway's refusal of an app without permissions.sessionApproval (api-reference.md). */
export function isApprovalNotGranted(status, data) {
  return status === 403 && !!data && data.code === 'session_approval_not_granted';
}

export const APPROVE_IN_KIRO_CREW =
  'VS Code cannot answer this approval until the dashboard owner allows chat control for the VS Code app ' +
  '(Kiro Crew, Apps, VS Code, "Enable and allow chat control"). Approve or reject it in the Kiro Crew session.';

/**
 * Polls the slot while the turn waits on an approval or a question, so a
 * decision made in Kiro Crew (or an answer from another window) clears the
 * VS Code card. One tick at a time; stop() ends it.
 */
export class TurnWatcher {
  constructor({ gateway, slot, renderer, write, intervalMs = 1000, questionsEnabled = () => false, log = () => {} }) {
    Object.assign(this, { gateway, slot, renderer, write, intervalMs, questionsEnabled, log });
    this.timer = null;
    this.stopped = false;
    this.questions = new Map(); // askId -> card
    this.busy = false;
  }

  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => this.tick().catch((e) => this.log('watch tick failed', e.message)), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** At turn end: every question still shown is over. */
  finish() {
    this.stop();
    const out = [...this.questions.keys()].map((askId) => ({ kind: 'questionResolved', askId }));
    this.questions.clear();
    return out;
  }

  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const ids = this.renderer.pendingIds();
      if (ids.length) {
        const detail = await this.gateway.slotDetail(this.slot, 60);
        for (const id of ids) {
          const st = approvalStateIn(detail && detail.messages, id);
          if (st && st.resolved) for (const p of this.renderer.resolve(id, st.resolved)) this.write(p);
        }
      }
      if (this.questionsEnabled()) {
        const cards = normalizeQuestions(await this.gateway.questions(this.slot));
        const seen = new Set();
        for (const c of cards) {
          seen.add(c.askId);
          if (!this.questions.has(c.askId)) {
            this.questions.set(c.askId, c);
            this.write({ kind: 'question', ...c });
          }
        }
        for (const id of [...this.questions.keys()]) {
          if (!seen.has(id)) {
            this.questions.delete(id);
            this.write({ kind: 'questionResolved', askId: id });
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

// ---------------------------------------------------------------- registry

/** A fresh slot name for a new VS Code chat session in `folder`. */
export function newSessionSlotName(folder, rand = () => crypto.randomBytes(4).toString('hex')) {
  return `${slotNameFor(folder)}-${rand()}`;
}

export function sessionTitle(prompt) {
  const t = String(prompt || '').replace(/\s+/g, ' ').trim();
  return t ? (t.length > MAX_TITLE ? t.slice(0, MAX_TITLE - 1) + '…' : t) : 'New chat';
}

/**
 * The slots this app created for VS Code chat sessions, persisted as JSON:
 * {sessions: [{slot, folder, title, created, updated}]}. At most `max` are kept,
 * the least recently used dropped first (the slot itself stays in Kiro Crew).
 */
export class SessionRegistry {
  constructor({ file, now = () => Date.now(), max = 200 } = {}) {
    this.file = file;
    this.now = now;
    this.max = max;
    this.sessions = new Map();
    this.load();
  }

  load() {
    if (!this.file) return;
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      data = null;
    }
    for (const s of Array.isArray(data && data.sessions) ? data.sessions : []) {
      if (!s || typeof s.slot !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(s.slot) || typeof s.folder !== 'string') continue;
      this.sessions.set(s.slot, {
        slot: s.slot,
        folder: s.folder,
        title: sessionTitle(s.title),
        created: Number(s.created) || 0,
        updated: Number(s.updated) || Number(s.created) || 0,
      });
    }
  }

  save() {
    if (!this.file) return;
    const list = [...this.sessions.values()].sort((a, b) => b.updated - a.updated).slice(0, this.max);
    this.sessions = new Map(list.map((s) => [s.slot, s]));
    fs.writeFileSync(this.file, JSON.stringify({ sessions: list }, null, 2) + '\n');
  }

  add({ slot, folder, title }) {
    const t = this.now();
    const s = { slot, folder, title: sessionTitle(title), created: t, updated: t };
    this.sessions.set(slot, s);
    this.save();
    return s;
  }

  get(slot) {
    return this.sessions.get(slot) || null;
  }

  touch(slot, { title } = {}) {
    const s = this.sessions.get(slot);
    if (!s) return null;
    s.updated = this.now();
    if (title && s.title === 'New chat') s.title = sessionTitle(title);
    this.save();
    return s;
  }

  /** Sessions whose folder `inRoots` accepts, newest first. */
  list(inRoots = () => true) {
    return [...this.sessions.values()].filter((s) => inRoots(s.folder)).sort((a, b) => b.updated - a.updated);
  }
}
