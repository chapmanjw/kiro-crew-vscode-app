// A small stand-in for the Kiro Crew gateway's chat API, for unit tests and
// the smoke. It implements only what the launcher calls, with the same shapes
// as KiroCrew src/kiro_crew/dashboard (handlers/core.py api_app_token,
// chat_api/slot_create.py, chat_api/session_relaunch.py api_chat_slot_project,
// chat_api/chat_send.py SSE branch, chat_utils._build_stream_chunk,
// chat_api/slot_detail.py, chat_api/slot_approval.py, handlers/slot_question.py):
//   POST /api/apps/{name}/token          X-App-Secret -> {token}
//   GET  /api/status                     {version}
//   POST /api/chat/slots                 {name, title} -> slot row {key, project}
//   GET  /api/chat/slots                 {slots:[{key, title, project, workspace, running}]}; an app token sees
//                                        only the slots it created (ws_event_scope.filter_slots_for_app)
//   GET  /api/chat/slots/{slot}?limit=   {key, title, running, total, messages:[{role, content, cls, ts, meta}]}
//   POST /api/chat/slots/{slot}/project  {project}
//   POST /api/chat                       {slot, message} -> text/event-stream of rows, then [DONE]
//   POST /api/chat/slots/{slot}/stop
//   POST /api/chat/slots/{slot}/approve  {action, request_id, response_id}; 403 session_approval_not_granted without the grant
//   GET  /api/chat/slots/{slot}/question {pending:[{ask_id, slot, questions}]}; same grant
//   POST /api/chat/slots/{slot}/question/answer {ask_id, answers} | {ask_id, dismissed}
// Every route but the token exchange needs the mc_token_<port> cookie.
//
// As on the real gateway, a streamed `tool` row carries only its title; its
// kind, input and output are on the persisted row that the slot detail
// returns. A streamed `permission` row carries its meta in `cls`.
//
// Messages that drive the mock:
//   "queue me"   the send is queued (JSON {queued: true})
//   "slow"       streams ticks until the client goes away
//   "approve me" a tool asks for approval and the turn waits for the decision
//   "ask me"     a blocking question card waits for an answer
// Test controls: closeSlot(key); rec.closeBeforeNextSend; deny(prefixes) for
// the out-of-scope 403; setGrant(false, cause) for session_approval_not_granted;
// resolveElsewhere(requestId, decision) decides as the Kiro Crew dashboard would.

import http from 'node:http';
import crypto from 'node:crypto';
import { attachDashboard } from './dashboard-mock.mjs';

export const MOCK_REPLY = 'Hello from the **Kiro Crew mock**.';

export function createGatewayMock({ appName = 'vscode-pane', secret, rejectFirstTokens = 0, defaultPermission = true } = {}) {
  const rec = { exchanges: 0, turns: [], stops: [], projects: [], slots: new Map(), aborted: [], requests: [], approvals: [], answers: [], details: 0 };
  const tokens = new Set();
  let rejectLeft = rejectFirstTokens;
  let denied = [];
  let grant = { granted: true, cause: '' };
  const waits = new Map(); // request_id -> {resolve, slot}
  const questionWaits = new Map(); // ask_id -> {resolve, card}
  let seq = 0;
  const SCOPE_DENIED = { error: 'app token not permitted for this endpoint', code: 'forbidden' };
  const notFound = { error: 'not found', code: 'slot_not_found' };
  let port = 0;
  const dashboard = attachDashboard(rec);

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
  const notGranted = () => ({
    error: `App "${appName}" cannot approve or answer in chat sessions yet: its installed version asks for permissions.sessionApproval, which the dashboard owner has not allowed.`,
    code: 'session_approval_not_granted',
    cause: grant.cause || 'consent_pending',
  });
  const persist = (slot, role, content, extra = {}) => {
    const row = { role, content, ts: new Date().toISOString(), cls: '', ...extra };
    slot.messages.push(row);
    return row;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    rec.requests.push(`${req.method} ${url.pathname}`);
    if (dashboard.handle(req, res, url)) return;
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
    if (req.method === 'GET' && url.pathname === '/api/chat/slots') {
      const slots = [...rec.slots.values()].map((s) => ({ key: s.key, title: s.title, project: s.project, workspace: s.project, running: s.running }));
      return json(res, 200, { slots });
    }
    if (req.method === 'POST' && url.pathname === '/api/chat/slots') {
      const b = await readJson(req);
      const key = String(b?.name || `slot-${rec.slots.size + 1}`);
      if (!rec.slots.has(key)) rec.slots.set(key, { key, title: b?.title || '', project: '', messages: [], running: false });
      const s = rec.slots.get(key);
      return json(res, 200, { key: s.key, title: s.title, project: s.project });
    }
    let m = /^\/api\/chat\/slots\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const slot = rec.slots.get(decodeURIComponent(m[1]));
      if (!slot) return json(res, 404, notFound);
      rec.details++;
      const limit = Math.max(1, Number(url.searchParams.get('limit')) || 200);
      return json(res, 200, { key: slot.key, title: slot.title, running: slot.running, total: slot.messages.length, messages: slot.messages.slice(-limit) });
    }
    m = /^\/api\/chat\/slots\/([^/]+)\/(question|question\/answer)$/.exec(url.pathname);
    if (m) {
      const key = decodeURIComponent(m[1]);
      const slot = rec.slots.get(key);
      if (!grant.granted) return json(res, 403, notGranted());
      if (!slot) return json(res, 404, notFound);
      if (req.method === 'GET' && m[2] === 'question') {
        const pending = [...questionWaits.values()].filter((w) => w.card.slot === key).map((w) => w.card);
        return json(res, 200, { pending });
      }
      if (req.method === 'POST' && m[2] === 'question/answer') {
        const b = await readJson(req);
        const w = questionWaits.get(String(b?.ask_id));
        if (!w) return json(res, 404, { error: 'no pending question', code: 'question_not_pending' });
        questionWaits.delete(String(b.ask_id));
        rec.answers.push({ slot: key, askId: b.ask_id, answers: b.answers || null, dismissed: b.dismissed === true });
        w.resolve(b.dismissed ? null : b.answers || {});
        return json(res, 200, { ok: true });
      }
    }
    m = /^\/api\/chat\/slots\/([^/]+)\/(project|stop|approve)$/.exec(url.pathname);
    if (req.method === 'POST' && m) {
      const key = decodeURIComponent(m[1]);
      const slot = rec.slots.get(key);
      if (m[2] === 'approve' && !grant.granted) {
        rec.approvals.push({ slot: key, refused: true });
        return json(res, 403, notGranted());
      }
      if (!slot) return json(res, 404, notFound);
      const b = await readJson(req);
      if (m[2] === 'project') {
        slot.project = String(b?.project || '');
        rec.projects.push({ key, project: slot.project });
        return json(res, 200, { ok: true, project: slot.project });
      }
      if (m[2] === 'approve') {
        const w = waits.get(String(b?.request_id));
        rec.approvals.push({ slot: key, requestId: b?.request_id, action: b?.action, responseId: b?.response_id, pending: !!w });
        if (!w || w.slot !== key) return json(res, 404, { error: 'no pending approval', code: 'approval_not_pending' });
        w.resolve(String(b.action || 'rejected'));
        return json(res, 200, { ok: true });
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
      const slot = rec.slots.get(String(b.slot));
      rec.turns.push({ slot: b.slot, message: b.message });
      if (/\bqueue me\b/.test(b.message)) return json(res, 200, { ok: true, queued: true, queue_id: 'q1' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const row = (type, content, cls = '') => res.write(`data: ${JSON.stringify({ type, content, ts: new Date().toISOString(), cls })}\n\n`);
      row('user', b.message, 'msg msg-u');
      persist(slot, 'user', b.message);
      slot.running = true;
      const finish = (reply) => {
        row('assistant', reply, 'msg msg-a');
        persist(slot, 'assistant', reply);
        slot.running = false;
        res.end('data: [DONE]\n\n');
      };
      if (/\bslow\b/.test(b.message)) {
        // Streams until the client goes away; records the abort.
        let n = 0;
        const timer = setInterval(() => row('chunk', `tick ${++n} `, 'chunk'), 100);
        res.on('close', () => {
          clearInterval(timer);
          slot.running = false;
          rec.aborted.push(b.slot);
        });
        return;
      }
      if (/\bapprove me\b/.test(b.message)) {
        const n = ++seq;
        const requestId = `req-${n}`;
        row('chunk', 'Running the tests. ', 'chunk');
        row('tool', '🔧 Run npm test', 'msg msg-tool');
        const toolRow = persist(slot, 'tool', '🔧 Run npm test', { cls: 'msg msg-tool', meta: { tool_call_id: `call-${n}`, kind: 'execute', input: '{"command":"npm test"}' } });
        const meta = { request_id: requestId, tool_call_id: `call-${n}`, tool_title: 'Run npm test', tool_kind: 'execute', full_command: 'npm test', is_shell: '1' };
        // A permission request closes the reply segment first, so the text so
        // far lands above the card (slot_transcript.py, the owed segment cut).
        row('assistant', 'Running the tests. ', 'msg msg-a');
        persist(slot, 'assistant', 'Running the tests. ');
        row('permission', 'Run npm test', JSON.stringify(meta));
        const permRow = persist(slot, 'permission', 'Run npm test', { cls: JSON.stringify(meta) });
        const decision = await new Promise((resolve) => {
          waits.set(requestId, { resolve, slot: slot.key });
          res.on('close', () => resolve('closed'));
        });
        waits.delete(requestId);
        if (decision === 'closed') {
          slot.running = false;
          return;
        }
        permRow.cls = JSON.stringify({ ...meta, resolved: decision });
        const ok = decision === 'approved' || decision.startsWith('trust');
        toolRow.meta = { ...toolRow.meta, done: true, output: ok ? '12 passing' : 'rejected', ...(ok ? {} : { status: 'failed' }) };
        if (!ok) toolRow.content = '🚫 Run npm test (rejected)';
        finish(ok ? 'Approved: npm test ran, 12 passing.' : `The command was ${decision}.`);
        return;
      }
      if (/\bask me\b/.test(b.message)) {
        const askId = `ask-${++seq}`;
        const card = { ask_id: askId, slot: slot.key, questions: [{ question: 'Which colour?', header: 'PICK', options: [{ label: 'Red' }, { label: 'Blue' }] }], ts: Date.now() / 1000 };
        const answers = await new Promise((resolve) => {
          questionWaits.set(askId, { resolve, card });
          res.on('close', () => resolve('closed'));
        });
        questionWaits.delete(askId);
        if (answers === 'closed') return;
        finish(answers ? `You chose ${Object.values(answers).join(', ')}.` : 'You dismissed the question.');
        return;
      }
      res.write(': keepalive\n\n');
      row('chunk', 'Hello from ', 'chunk');
      row('chunk', 'the **Kiro Crew mock**.', 'chunk');
      row('tool', '🔧 Reading hello.txt', 'msg msg-tool');
      persist(slot, 'tool', '🔧 Reading hello.txt', { cls: 'msg msg-tool', meta: { tool_call_id: `read-${++seq}`, kind: 'read', input: '{"path":"hello.txt"}', output: 'line one\nline two', done: true } });
      if (defaultPermission) row('permission', 'Run shell command', JSON.stringify({ tool_call_id: 't1' }));
      finish(MOCK_REPLY);
      return;
    }
    return json(res, 404, { error: 'not found' });
  });

  const upgraded = new Set();
  server.on('upgrade', (req, socket) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    if (new URL(req.url, 'http://x').pathname === '/api/ws') return dashboard.upgrade(req, socket);
    socket.destroy();
  });

  return {
    server,
    rec,
    /** A sign-in link for the owner's dashboard session (test/support/dashboard-mock.mjs). */
    mintLink: (origin) => dashboard.mintLink(origin),
    closeSlot(key) {
      rec.slots.delete(key);
    },
    deny(prefixes = []) {
      denied = [...prefixes];
    },
    setGrant(granted, cause = 'consent_pending') {
      grant = { granted: !!granted, cause };
    },
    /** Decide a pending approval as the Kiro Crew dashboard would (not through the app). */
    resolveElsewhere(requestId, decision = 'approved') {
      const w = waits.get(String(requestId));
      if (!w) return false;
      w.resolve(decision);
      return true;
    },
    pendingApprovals() {
      return [...waits.keys()];
    },
    pendingQuestions() {
      return [...questionWaits.keys()];
    },
    async listen() {
      await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
      port = server.address().port;
      return `http://127.0.0.1:${port}`;
    },
    close() {
      for (const w of waits.values()) w.resolve('closed');
      for (const w of questionWaits.values()) w.resolve('closed');
      for (const s of upgraded) s.destroy();
      server.closeAllConnections?.();
      return new Promise((ok) => server.close(() => ok()));
    },
  };
}
