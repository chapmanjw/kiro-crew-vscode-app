// A small stand-in for the Kiro Crew gateway's chat API, for unit tests and
// the smoke. It implements only what the launcher calls, with the same shapes
// as KiroCrew src/kiro_crew/dashboard (handlers/core.py api_app_token,
// chat_api/slot_create.py, chat_api/session_relaunch.py api_chat_slot_project,
// chat_api/chat_send.py SSE branch, chat_utils._build_stream_chunk):
//   POST /api/apps/{name}/token          X-App-Secret -> {token}
//   GET  /api/status                     {version}
//   POST /api/chat/slots                 {name, title} -> slot row {key, project}
//   POST /api/chat/slots/{slot}/project  {project}
//   POST /api/chat                       {slot, message} -> text/event-stream of rows, then [DONE]
//   POST /api/chat/slots/{slot}/stop
// Every route but the token exchange needs the mc_token_<port> cookie.
// Test controls: closeSlot(key) removes a slot as closing its session in Kiro
// Crew does; rec.closeBeforeNextSend makes the next POST /api/chat find its slot
// gone (404 slot_not_found); deny(prefixes) answers those paths with the
// gateway's out-of-scope 403, as for permissions.api entries not yet approved.

import http from 'node:http';
import crypto from 'node:crypto';

export const MOCK_REPLY = 'Hello from the **Kiro Crew mock**.';

export function createGatewayMock({ appName = 'vscode-pane', secret, rejectFirstTokens = 0 } = {}) {
  const rec = { exchanges: 0, turns: [], stops: [], projects: [], slots: new Map(), aborted: [], requests: [] };
  const tokens = new Set();
  let rejectLeft = rejectFirstTokens;
  let denied = [];
  const SCOPE_DENIED = { error: 'app token not permitted for this endpoint', code: 'forbidden' };
  const notFound = { error: 'not found', code: 'slot_not_found' };
  let port = 0;

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readJson = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          resolve(null);
        }
      });
    });
  const authed = (req) => {
    const m = new RegExp(`(?:^|;\\s*)mc_token_${port}=([^;]+)`).exec(req.headers.cookie || '');
    if (!m || !tokens.has(m[1])) return false;
    if (rejectLeft > 0) {
      // Simulates an expired token: the client must exchange again and replay.
      rejectLeft--;
      tokens.delete(m[1]);
      return false;
    }
    return true;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    rec.requests.push(`${req.method} ${url.pathname}`);
    if (req.method === 'POST' && url.pathname === `/api/apps/${appName}/token`) {
      if (req.headers['x-app-secret'] !== secret) return json(res, 403, { error: 'invalid secret' });
      rec.exchanges++;
      const t = crypto.randomBytes(16).toString('hex');
      tokens.add(t);
      return json(res, 200, { token: t });
    }
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
    if (denied.some((d) => url.pathname === d || url.pathname.startsWith(d + '/'))) return json(res, 403, SCOPE_DENIED);
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, { version: '0.0.0-mock', owner_id_hash: 'x' });
    if (req.method === 'POST' && url.pathname === '/api/chat/slots') {
      const b = await readJson(req);
      const key = String(b?.name || `slot-${rec.slots.size + 1}`);
      if (!rec.slots.has(key)) rec.slots.set(key, { key, title: b?.title || '', project: '' });
      return json(res, 200, rec.slots.get(key));
    }
    let m = /^\/api\/chat\/slots\/([^/]+)\/(project|stop)$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const key = decodeURIComponent(m[1]);
      const slot = rec.slots.get(key);
      if (!slot) return json(res, 404, notFound);
      const b = await readJson(req);
      if (m[2] === 'project') {
        slot.project = String(b?.project || '');
        rec.projects.push({ key, project: slot.project });
        return json(res, 200, { ok: true, project: slot.project });
      }
      rec.stops.push(key);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const b = await readJson(req);
      if (rec.closeBeforeNextSend && b) {
        rec.closeBeforeNextSend = false;
        rec.slots.delete(String(b.slot));
      }
      if (!b || !rec.slots.has(String(b.slot))) return json(res, 404, notFound);
      rec.turns.push({ slot: b.slot, message: b.message });
      if (/\bqueue me\b/.test(b.message)) return json(res, 200, { ok: true, queued: true, queue_id: 'q1' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const row = (type, content, cls = '') => res.write(`data: ${JSON.stringify({ type, content, ts: new Date().toISOString(), cls })}\n\n`);
      row('user', b.message, 'msg msg-u');
      if (/\bslow\b/.test(b.message)) {
        // Streams until the client goes away; records the abort.
        let n = 0;
        const timer = setInterval(() => row('chunk', `tick ${++n} `, 'chunk'), 100);
        res.on('close', () => {
          clearInterval(timer);
          rec.aborted.push(b.slot);
        });
        return;
      }
      res.write(': keepalive\n\n');
      row('chunk', 'Hello from ', 'chunk');
      row('chunk', 'the **Kiro Crew mock**.', 'chunk');
      row('tool', '🔧 Reading hello.txt', 'msg msg-tool');
      row('permission', 'Run shell command', JSON.stringify({ tool_call_id: 't1' }));
      row('assistant', MOCK_REPLY, 'msg msg-a');
      res.end('data: [DONE]\n\n');
      return;
    }
    return json(res, 404, { error: 'not found' });
  });

  return {
    server,
    rec,
    closeSlot(key) {
      rec.slots.delete(key);
    },
    deny(prefixes = []) {
      denied = [...prefixes];
    },
    async listen() {
      await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
      port = server.address().port;
      return `http://127.0.0.1:${port}`;
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((ok) => server.close(() => ok()));
    },
  };
}
