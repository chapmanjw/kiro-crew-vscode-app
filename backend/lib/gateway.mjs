// Client for the Kiro Crew gateway REST API, authenticated with an app token.
//
// A backend the gateway spawned gets KIROCREW_PROXY_SECRET and
// KIROCREW_GATEWAY_ORIGIN. It trades the secret for a one-hour app token at
// POST /api/apps/{name}/token (header X-App-Secret; KiroCrew
// src/kiro_crew/dashboard/handlers/core.py api_app_token) and sends the token as
// the `mc_token_<port>` cookie (docs/app-kit/api-reference.md, App token and
// KiroCrewClient sections). The token is confined to the app's
// permissions.api, so this client needs "/api/chat" (covers /api/chat/slots/*)
// and "/api/status".
//
// A chat turn is POST /api/chat {slot, message} without ?ws=1, which answers
// with an SSE stream of slot rows ({type, content, ts, cls[, meta]}) ending in
// `data: [DONE]` (chat_api/chat_send.py, the text/event-stream branch; same in
// the installed 0.13.0-rc.1). No WebSocket is needed.

import crypto from 'node:crypto';
import path from 'node:path';

export const TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export class GatewayError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** The API prefixes this app's chat needs in app.json permissions.api. */
export const CHAT_PERMISSIONS = Object.freeze(['/api/chat', '/api/chat/slots', '/api/status']);

/**
 * The text the gateway sends when an app token calls a path outside the app's
 * approved permissions.api (token_auth_app_scope.py _enforce_app_scope ->
 * token_auth_paths.py _deny: 403 {"error": "app token not permitted for this
 * endpoint", "code": "forbidden"}). After an Update the new prefixes stay
 * unapproved until the app is turned on again and they are accepted.
 */
const SCOPE_DENIED_RE = /not permitted for this endpoint/i;

export const PERMISSION_MESSAGE =
  `Kiro Crew has not approved this app's chat permissions (${CHAT_PERMISSIONS.join(', ')}). ` +
  'An Update turns the app off; turn VS Code back on in Kiro Crew Apps and approve the new API permissions, then try again.';

/** True for the gateway's out-of-scope 403. */
export function isScopeDenied(status, data) {
  return status === 403 && !!data && typeof data.error === 'string' && SCOPE_DENIED_RE.test(data.error);
}

/** Slot errors that mean the cached slot was closed or removed in Kiro Crew. */
export function isSlotGone(err) {
  return !!err && (err.status === 404 || err.code === 'slot_not_found' || err.code === 'slot_closed');
}

/** Cookie name the gateway reads for the origin we call (token_auth.py: mc_token_<port>). */
export function cookieNameFor(origin) {
  const u = new URL(origin);
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return `mc_token_${port}`;
}

/** A gateway origin we are willing to call: http(s) on a loopback host. */
export function gatewayOriginAllowed(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Deterministic slot name for a workspace folder, so the same folder always
 * reaches the same Kiro Crew session. Lower-case letters, digits and dashes.
 */
export function slotNameFor(folder) {
  const norm = String(folder || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const key = process.platform === 'win32' ? norm.toLowerCase() : norm;
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 10);
  const base = path.posix.basename(norm).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return `vscode-${base || 'workspace'}-${hash}`;
}

/** Split an SSE byte stream into `data:` payloads. Comments and other fields are skipped. */
export class SseParser {
  constructor() {
    this.buf = '';
  }
  /** @returns {string[]} complete data payloads */
  push(text) {
    this.buf += text.replace(/\r\n/g, '\n');
    const out = [];
    let i;
    while ((i = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''));
      if (data.length) out.push(data.join('\n'));
    }
    return out;
  }
}

/**
 * Turns gateway slot rows into chat response parts for VS Code:
 *   {kind:'markdown', text} | {kind:'progress', text} | {kind:'warning', text}
 * Streamed `chunk` rows carry the reply text; the `assistant` row that closes a
 * segment repeats it, so only text the chunks did not already carry is emitted.
 */
export class TurnRenderer {
  constructor() {
    this.segment = '';
    this.wroteAny = false;
  }

  push(row) {
    if (!row || typeof row !== 'object') return [];
    const type = typeof row.type === 'string' ? row.type : '';
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
        let text;
        if (!seg) text = (this.wroteAny ? '\n\n' : '') + content;
        else if (content.startsWith(seg)) text = content.slice(seg.length);
        else text = '';
        if (!text) return [];
        this.wroteAny = true;
        return [{ kind: 'markdown', text }];
      }
      case 'tool':
        return content ? [{ kind: 'progress', text: oneLine(content) }] : [];
      case 'permission': {
        const meta = parseMeta(row.cls);
        if (meta && meta.resolved) return [{ kind: 'progress', text: `${oneLine(content)} (${meta.resolved})` }];
        return [
          {
            kind: 'warning',
            text: `Kiro Crew is waiting for your approval: ${oneLine(content) || 'a tool call'}. Approve or reject it in the Kiro Crew session.`,
          },
        ];
      }
      case 'error':
        return content ? [{ kind: 'warning', text: oneLine(content, 500) }] : [];
      case 'notice':
      case 'system':
        return content ? [{ kind: 'progress', text: oneLine(content) }] : [];
      default:
        return []; // user echo, queued rows, thinking and anything new
    }
  }
}

function oneLine(s, max = 200) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
function parseMeta(cls) {
  if (cls && typeof cls === 'object') return cls;
  if (typeof cls !== 'string' || !cls.startsWith('{')) return null;
  try {
    return JSON.parse(cls);
  } catch {
    return null;
  }
}

export class GatewayClient {
  /**
   * @param {{origin:string, appName:string, secret:string, fetch?:typeof fetch, now?:()=>number, log?:(...a:any[])=>void}} opts
   */
  constructor({ origin, appName, secret, fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {} }) {
    this.origin = origin ? String(origin).replace(/\/+$/, '') : '';
    this.appName = appName || '';
    this.secret = secret || '';
    this.fetch = fetchImpl;
    this.now = now;
    this.log = log;
    this.tokenValue = '';
    this.tokenAt = 0;
    this.inflight = null;
    this.lastError = null;
    this.lastTokenAt = null;
    this.slots = new Map(); // folder -> slot key
    this.permissionDenied = null; // {path, at} after the gateway's out-of-scope 403
    this.approvalGrant = null; // {granted, cause?, message?, at}: permissions.sessionApproval as the gateway last answered
  }

  /** Record the outcome of a gateway call for the permission state; returns the error to throw, if any. */
  noteResponse(method, p, status, data) {
    if (isScopeDenied(status, data)) {
      this.permissionDenied = { path: p.split('?')[0], at: new Date(this.now()).toISOString() };
      this.lastError = PERMISSION_MESSAGE;
      return new GatewayError(PERMISSION_MESSAGE, { status, code: 'permission' });
    }
    if (status >= 200 && status < 300) this.permissionDenied = null;
    return null;
  }

  /** Why the client cannot run, or '' when it can. */
  get unavailableReason() {
    if (!this.origin) return 'no KIROCREW_GATEWAY_ORIGIN (not started by the gateway)';
    if (!gatewayOriginAllowed(this.origin)) return 'gateway origin is not a loopback http(s) URL';
    if (!this.secret) return 'no KIROCREW_PROXY_SECRET to exchange for an app token';
    if (!this.appName) return 'no KIROCREW_APP_NAME';
    return '';
  }

  tokenExpiresAt() {
    return this.tokenAt ? new Date(this.tokenAt + TOKEN_TTL_MS).toISOString() : null;
  }

  /** The app token, exchanged on first use and again before the hour is up. */
  async token({ force = false } = {}) {
    const why = this.unavailableReason;
    if (why) throw new GatewayError(why, { code: 'unavailable' });
    const fresh = this.tokenValue && this.now() - this.tokenAt < TOKEN_TTL_MS - REFRESH_MARGIN_MS;
    if (fresh && !force) return this.tokenValue;
    if (!this.inflight) {
      this.inflight = this.exchange().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  async exchange() {
    const url = `${this.origin}/api/apps/${encodeURIComponent(this.appName)}/token`;
    let res;
    try {
      res = await this.fetch(url, { method: 'POST', headers: { 'X-App-Secret': this.secret }, redirect: 'manual' });
    } catch (e) {
      this.lastError = `gateway unreachable: ${e.message}`;
      throw new GatewayError(this.lastError, { code: 'unreachable' });
    }
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || typeof body.token !== 'string' || !body.token) {
      this.lastError = `token exchange refused (HTTP ${res.status}${body?.error ? ': ' + String(body.error).slice(0, 120) : ''})`;
      throw new GatewayError(this.lastError, { status: res.status, code: 'token' });
    }
    this.tokenValue = body.token;
    this.tokenAt = this.now();
    this.lastTokenAt = new Date(this.tokenAt).toISOString();
    this.lastError = null;
    this.log('gateway: app token exchanged, expires', this.tokenExpiresAt());
    return this.tokenValue;
  }

  /** A gateway request with the token cookie; one refresh and replay on 401/403. */
  async request(method, p, { body, signal, accept = 'application/json' } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tok = await this.token({ force: attempt > 0 });
      const headers = { Cookie: `${cookieNameFor(this.origin)}=${tok}`, Accept: accept };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res;
      try {
        res = await this.fetch(this.origin + p, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
          redirect: 'manual',
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        this.lastError = `gateway unreachable: ${e.message}`;
        throw new GatewayError(this.lastError, { code: 'unreachable' });
      }
      if ((res.status === 401 || res.status === 403) && attempt === 0) {
        await res.body?.cancel?.().catch(() => {});
        continue;
      }
      return res;
    }
    throw new GatewayError('unreachable');
  }

  async json(method, p, body) {
    const res = await this.request(method, p, { body });
    const data = await res.json().catch(() => null);
    const denied = this.noteResponse(method, p, res.status, data);
    if (denied) throw denied;
    if (!res.ok) {
      const msg = `${method} ${p.split('?')[0]} -> HTTP ${res.status}${data?.error ? ': ' + String(data.error).slice(0, 160) : ''}`;
      this.lastError = msg;
      throw new GatewayError(msg, { status: res.status, code: data?.code || '' });
    }
    return data;
  }

  /** GET /api/status, reduced to what is safe to show. */
  async status() {
    const s = await this.json('GET', '/api/status');
    return { version: typeof s?.version === 'string' ? s.version : null };
  }

  /**
   * The Kiro Crew chat slot for a workspace folder: created (or reopened, the
   * create is idempotent by name) and pointed at the folder as its project.
   * Run on every turn, not cached: John can close or delete the
   * "VS Code: <folder>" session in Kiro Crew at any time, and a send to a slot
   * that is gone would fail or open a session with no project. For a slot that
   * is still open the create is a no-op and the project is set only if it
   * changed.
   */
  async ensureSlot(folder) {
    const key = await this.ensureSlotNamed({
      name: slotNameFor(folder),
      title: `VS Code: ${path.basename(String(folder).replace(/[\\/]+$/, '')) || folder}`,
      folder,
    });
    this.slots.set(folder, key);
    return key;
  }

  /**
   * Create (or reopen; the create is idempotent by name) a slot with this name
   * and point it at `folder`. Used per folder by the 0.3.1 participant and per
   * VS Code chat session by the Kiro Crew session type.
   */
  async ensureSlotNamed({ name, title, folder }) {
    const created = await this.json('POST', '/api/chat/slots', { name, title });
    const key = (created && (created.key || created.slot || created.name)) || name;
    if (folder && created?.project !== folder) {
      try {
        await this.json('POST', `/api/chat/slots/${encodeURIComponent(key)}/project`, { project: folder });
      } catch (e) {
        this.log('gateway: could not set slot project', e.message);
      }
    }
    return key;
  }

  /** GET /api/chat/slots/{slot}?limit= : {key, title, running, total, messages:[{role, content, cls, ts, meta}]}. */
  async slotDetail(slot, limit = 200) {
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    return this.json('GET', `/api/chat/slots/${encodeURIComponent(slot)}?limit=${n}`);
  }

  /**
   * POST /api/chat/slots/{slot}/approve. An app token needs
   * permissions.sessionApproval and the owner's consent; without them the
   * gateway answers 403 session_approval_not_granted (slot_approval.py
   * deny_session_approval_caller, session_approval_refusal.py).
   * @returns {Promise<{ok:boolean, status:number, code?:string, cause?:string, error?:string}>}
   */
  async approve(slot, { requestId, action, responseId }) {
    const res = await this.request('POST', `/api/chat/slots/${encodeURIComponent(slot)}/approve`, {
      body: { action, request_id: requestId, response_id: responseId || crypto.randomBytes(9).toString('base64url') },
    });
    const data = await res.json().catch(() => null);
    const denied = this.noteResponse('POST', '/api/chat/slots/approve', res.status, data);
    if (denied) return { ok: false, status: res.status, code: 'permission', error: denied.message };
    this.noteApprovalGrant(res.status, data);
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, code: data?.code || '', cause: data?.cause || '', error: typeof data?.error === 'string' ? data.error.slice(0, 1000) : `HTTP ${res.status}` };
  }

  /** GET /api/chat/slots/{slot}/question: the slot's pending question cards (same grant as approvals). */
  async questions(slot) {
    const res = await this.request('GET', `/api/chat/slots/${encodeURIComponent(slot)}/question`);
    const data = await res.json().catch(() => null);
    this.noteApprovalGrant(res.status, data);
    if (!res.ok) throw new GatewayError(`question read -> HTTP ${res.status}`, { status: res.status, code: data?.code || '' });
    return Array.isArray(data?.pending) ? data.pending : [];
  }

  /** POST /api/chat/slots/{slot}/question/answer {ask_id, answers} or {ask_id, dismissed:true}. */
  async answerQuestion(slot, { askId, answers, dismissed }) {
    const body = dismissed ? { ask_id: askId, dismissed: true } : { ask_id: askId, answers };
    const res = await this.request('POST', `/api/chat/slots/${encodeURIComponent(slot)}/question/answer`, { body });
    const data = await res.json().catch(() => null);
    this.noteApprovalGrant(res.status, data);
    if (res.ok) return { ok: true, status: res.status };
    return { ok: false, status: res.status, code: data?.code || '', error: typeof data?.error === 'string' ? data.error.slice(0, 1000) : `HTTP ${res.status}` };
  }

  /** Remember whether the gateway accepts our approvals: {granted, cause, message, at}. */
  noteApprovalGrant(status, data) {
    const at = new Date(this.now()).toISOString();
    if (status === 403 && data && data.code === 'session_approval_not_granted') {
      this.approvalGrant = { granted: false, cause: String(data.cause || ''), message: typeof data.error === 'string' ? data.error.slice(0, 1000) : '', at };
    } else if (status >= 200 && status < 300) {
      this.approvalGrant = { granted: true, at };
    }
  }

  /**
   * Whether approvals from this app are allowed, probing the question read
   * (which needs the same grant and changes nothing) when unknown or older
   * than `maxAgeMs`.
   */
  async approvalGrantFor(slot, { maxAgeMs = 60_000 } = {}) {
    const g = this.approvalGrant;
    if (g && this.now() - Date.parse(g.at) < maxAgeMs) return g;
    try {
      await this.questions(slot);
    } catch {
      /* noted by questions() when it was the grant */
    }
    return this.approvalGrant || { granted: false, cause: 'unavailable', message: '', at: new Date(this.now()).toISOString() };
  }

  /**
   * Send one turn and stream its rows.
   * @param {{slot:string, message:string, signal?:AbortSignal, onRow:(row:object)=>void}} o
   * @returns {Promise<{queued?:boolean, done:boolean}>}
   */
  async sendTurn({ slot, message, signal, onRow }) {
    const res = await this.request('POST', '/api/chat', {
      body: { slot, message },
      signal,
      accept: 'text/event-stream, application/json',
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('text/event-stream')) {
      const data = await res.json().catch(() => null);
      const denied = this.noteResponse('POST', '/api/chat', res.status, data);
      if (denied) throw denied;
      if (res.ok && data && data.queued) return { queued: true, done: false };
      const msg = `chat send -> HTTP ${res.status}${data?.error ? ': ' + String(data.error).slice(0, 200) : ''}`;
      this.lastError = msg;
      throw new GatewayError(msg, { status: res.status, code: data?.code || '' });
    }
    this.noteResponse('POST', '/api/chat', res.status, null);
    const parser = new SseParser();
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      for (const data of parser.push(decoder.decode(chunk, { stream: true }))) {
        if (data === '[DONE]') return { done: true };
        let row;
        try {
          row = JSON.parse(data);
        } catch {
          continue;
        }
        onRow(row);
      }
    }
    return { done: false };
  }

  /** Stop the running turn in a slot (Stop in the dashboard). */
  async stop(slot) {
    const res = await this.request('POST', `/api/chat/slots/${encodeURIComponent(slot)}/stop`, { body: {} });
    await res.body?.cancel?.().catch(() => {});
    return res.ok;
  }
}
