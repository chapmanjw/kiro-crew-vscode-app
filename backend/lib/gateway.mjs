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
   */
  async ensureSlot(folder) {
    const cached = this.slots.get(folder);
    if (cached) return cached;
    const name = slotNameFor(folder);
    const created = await this.json('POST', '/api/chat/slots', {
      name,
      title: `VS Code: ${path.basename(String(folder).replace(/[\\/]+$/, '')) || folder}`,
    });
    const key = (created && (created.key || created.slot || created.name)) || name;
    if (folder && created?.project !== folder) {
      try {
        await this.json('POST', `/api/chat/slots/${encodeURIComponent(key)}/project`, { project: folder });
      } catch (e) {
        this.log('gateway: could not set slot project', e.message);
      }
    }
    this.slots.set(folder, key);
    return key;
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
      if (res.ok && data && data.queued) return { queued: true, done: false };
      const msg = `chat send -> HTTP ${res.status}${data?.error ? ': ' + String(data.error).slice(0, 200) : ''}`;
      this.lastError = msg;
      throw new GatewayError(msg, { status: res.status, code: data?.code || '' });
    }
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
