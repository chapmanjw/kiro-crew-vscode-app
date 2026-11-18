// Round 3, native Chat takeover: the "Kiro Crew" chat session type's launcher
// side (structured rows, tool reconcile, history, approvals relayed to the
// gateway, questions, the session registry, the hide-Copilot-agents setting
// and the crew chat toggle counter for the page).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { GatewayClient, slotNameFor } from '../backend/lib/gateway.mjs';
import { runNativeTurn, parseNativeChatRequest } from '../backend/lib/chatbridge.mjs';
import {
  NativeTurnRenderer, reconcileTools, historyTurns, approvalStateIn, normalizeQuestions, toolTitle,
  SessionRegistry, newSessionSlotName, isAppSessionSlot, sessionTitle, currentTurnRows,
} from '../backend/lib/nativechat.mjs';
import { chatSettings, parseChatPrefs } from '../backend/lib/chatprefs.mjs';
import { seedThemeSettings } from '../backend/lib/theme.mjs';
import { matchRoute } from '../backend/lib/router.mjs';
import { Bridge } from '../backend/lib/bridge.mjs';
import { signProxyRequest } from '../backend/lib/auth.mjs';
import { createGatewayMock } from './support/gateway-mock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FOLDER = process.platform === 'win32' ? 'C:\\work\\demo' : '/work/demo';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withMock(fn, opts = {}) {
  const mock = createGatewayMock({ appName: 'vscode-pane', secret: 's3cret', ...opts });
  const origin = await mock.listen();
  try {
    await fn(mock, new GatewayClient({ origin, appName: 'vscode-pane', secret: 's3cret' }));
  } finally {
    await mock.close();
  }
}

// ---------------------------------------------------------------- renderer

test('NativeTurnRenderer: text once, tool cards with ids, approvals with their meta, resolution', () => {
  const r = new NativeTurnRenderer();
  const perm = { request_id: 'req-1', tool_call_id: 'c1', tool_title: 'Run npm test', tool_kind: 'execute', full_command: 'npm test', tool_purpose: 'run the tests', is_read_only: '' };
  const out = [
    { type: 'user', content: 'hi' },
    { type: 'chunk', content: 'Hel' },
    { type: 'chunk', content: 'lo' },
    { type: 'tool', content: '🔧 Reading hello.txt', cls: 'msg msg-tool' },
    { type: 'thinking', content: 'pondering' },
    { type: 'permission', content: 'Run npm test', cls: JSON.stringify(perm) },
    { type: 'permission', content: 'Run npm test', cls: JSON.stringify(perm) }, // repeated: one card
    { type: 'tool', content: '🚫 Write secrets (rejected)', cls: 'msg msg-tool' },
    { type: 'permission', content: 'Run npm test', cls: JSON.stringify({ ...perm, resolved: 'approved' }) },
    { type: 'assistant', content: 'Hello' },
    { type: 'notice', content: 'model switched' },
  ].flatMap((row) => r.push(row));
  assert.deepEqual(out, [
    { kind: 'markdown', text: 'Hel' },
    { kind: 'markdown', text: 'lo' },
    { kind: 'tool', id: 'kc-tool-1', title: 'Reading hello.txt', state: 'running' },
    { kind: 'thinking', text: 'pondering' },
    { kind: 'approval', requestId: 'req-1', title: 'Run npm test', toolKind: 'execute', input: 'npm test', purpose: 'run the tests', readOnly: false },
    { kind: 'tool', id: 'kc-tool-2', title: 'Write secrets (rejected)', state: 'error' },
    { kind: 'approvalResolved', requestId: 'req-1', resolved: 'approved' },
    { kind: 'notice', text: 'model switched' },
  ]);
  assert.deepEqual(r.pendingIds(), []);
  assert.deepEqual(r.push({ type: 'permission', content: 'x', cls: '{"tool_call_id":"t"}' })[0].requestId, null, 'a pending row with no id still shows, with no id');
  assert.deepEqual(toolTitle('🔧 Reading a.txt'), { title: 'Reading a.txt', failed: false });
  assert.deepEqual(toolTitle(''), { title: 'tool', failed: false });
});

test('reconcileTools completes live cards from the persisted rows of the current turn, by position', () => {
  const messages = [
    { role: 'user', content: 'earlier' },
    { role: 'tool', content: '🔧 Old tool', meta: { kind: 'read', input: 'old', output: 'old', done: true } },
    { role: 'user', content: 'now' },
    { role: 'tool', content: '🔧 Reading hello.txt', meta: { kind: 'read', input: '{"path":"hello.txt"}', output: 'line one', done: true } },
    { role: 'tool', content: '🔧 Run npm test', meta: { kind: 'execute', input: '{"command":"npm test"}', output: 'boom', status: 'failed' } },
  ];
  assert.equal(currentTurnRows(messages).length, 2);
  const live = [
    { id: 'kc-tool-1', title: 'Reading hello.txt', state: 'running' },
    { id: 'kc-tool-2', title: 'Run npm test', state: 'running' },
    { id: 'kc-tool-3', title: 'Unmatched', state: 'running' },
  ];
  assert.deepEqual(reconcileTools(live, messages), [
    { kind: 'tool', id: 'kc-tool-1', title: 'Reading hello.txt', state: 'done', toolKind: 'read', input: '{"path":"hello.txt"}', output: 'line one' },
    { kind: 'tool', id: 'kc-tool-2', title: 'Run npm test', state: 'error', toolKind: 'execute', input: '{"command":"npm test"}', output: 'boom' },
    { kind: 'tool', id: 'kc-tool-3', title: 'Unmatched', state: 'done' },
  ]);
});

test('historyTurns rebuilds request and response turns from slot rows', () => {
  const turns = historyTurns([
    { role: 'notice', content: 'session started' },
    { role: 'user', content: 'read it' },
    { role: 'tool', content: '🔧 Reading a.txt', meta: { tool_call_id: 'c9', kind: 'read', input: 'a.txt', output: 'A' } },
    { role: 'assistant', content: 'It says A.' },
    { role: 'assistant', content: 'Anything else?' },
    { role: 'permission', content: 'Run x', cls: '{"request_id":"r","resolved":"approved"}' },
    { role: 'user', content: 'no' },
    { role: 'error', content: 'model failed' },
  ]);
  assert.deepEqual(turns, [
    { role: 'user', text: 'read it' },
    {
      role: 'assistant',
      parts: [
        { kind: 'tool', id: 'c9', title: 'Reading a.txt', state: 'done', toolKind: 'read', input: 'a.txt', output: 'A' },
        { kind: 'markdown', text: 'It says A.\n\nAnything else?' },
      ],
    },
    { role: 'user', text: 'no' },
    { role: 'assistant', parts: [{ kind: 'markdown', text: '> **Kiro Crew:** model failed' }] },
  ]);
  assert.deepEqual(historyTurns(null), []);
});

test('approvalStateIn finds a permission row by request id; normalizeQuestions keeps blocking cards only', () => {
  const rows = [
    { role: 'permission', content: 'x', cls: '{"request_id":"a"}' },
    { role: 'permission', content: 'y', cls: '{"request_id":"b","resolved":"rejected"}' },
  ];
  assert.deepEqual(approvalStateIn(rows, 'a'), { resolved: null });
  assert.deepEqual(approvalStateIn(rows, 'b'), { resolved: 'rejected' });
  assert.equal(approvalStateIn(rows, 'zz'), null);
  assert.deepEqual(
    normalizeQuestions([
      { ask_id: 'k1', questions: [{ question: 'Which?', header: 'H', options: [{ label: 'A' }, 'B', {}], multiSelect: true }, { nope: 1 }] },
      { card_id: 'native-1', native: true, questions: [{ question: 'Q', options: [] }] },
    ]),
    [{ askId: 'k1', questions: [{ question: 'Which?', header: 'H', options: ['A', 'B'], multiSelect: true }] }],
  );
});

// ---------------------------------------------------------------- registry and prefs

test('SessionRegistry persists sessions per folder, newest first, and survives a reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-reg-'));
  const file = path.join(dir, 'chat-sessions.json');
  let t = 1000;
  const reg = new SessionRegistry({ file, now: () => t, max: 3 });
  const a = reg.add({ slot: newSessionSlotName(FOLDER, () => 'aaaaaaaa'), folder: FOLDER, title: '' });
  const other = newSessionSlotName('/elsewhere', () => 'bbbbbbbb');
  t = 2000;
  reg.add({ slot: other, folder: '/elsewhere', title: 'x'.repeat(200) });
  assert.equal(a.slot, `${slotNameFor(FOLDER)}-aaaaaaaa`);
  assert.equal(a.title, 'New chat');
  t = 3000;
  reg.touch(a.slot, { title: 'fix the build' });
  const again = new SessionRegistry({ file, now: () => t });
  assert.deepEqual(again.list().map((s) => s.slot), [a.slot, other]);
  assert.equal(again.get(a.slot).title, 'fix the build');
  assert.equal(again.get(other).title.length, 80);
  assert.deepEqual(again.list((f) => f === FOLDER).map((s) => s.slot), [a.slot]);
  const okSlot = newSessionSlotName('/x', () => '0123abcd');
  fs.writeFileSync(file, JSON.stringify({ sessions: [{ slot: 'bad slot!', folder: '/x' }, { slot: okSlot, folder: '/x' }] }));
  assert.deepEqual(new SessionRegistry({ file }).list().map((s) => s.slot), [okSlot], 'malformed slot names are dropped');
  assert.equal(sessionTitle('  a\n b  '), 'a b');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S-2: the registry relays only slots the app minted for that same folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-reg2-'));
  const file = path.join(dir, 'chat-sessions.json');
  const mine = newSessionSlotName(FOLDER, () => '89abcdef');
  const forged = [
    { slot: 'dashboard:chat-1', folder: FOLDER }, // John's own session, hand-registered
    { slot: slotNameFor(FOLDER), folder: FOLDER }, // the folder's main slot, not a VS Code chat
    { slot: newSessionSlotName('/other', () => '89abcdef'), folder: FOLDER }, // minted for another folder
    { slot: `${slotNameFor(FOLDER)}-89ABCDEF`, folder: FOLDER }, // not lower-case hex
    { slot: `${slotNameFor(FOLDER)}-89abcdef0`, folder: FOLDER }, // too long
  ];
  fs.writeFileSync(file, JSON.stringify({ sessions: [{ slot: mine, folder: FOLDER }, ...forged] }));
  const reg = new SessionRegistry({ file });
  assert.deepEqual(reg.list().map((s) => s.slot), [mine]);
  for (const f of forged) assert.equal(reg.get(f.slot), null, f.slot);
  // An entry injected after load is refused on use as well.
  reg.sessions.set('dashboard:chat-1', { slot: 'dashboard:chat-1', folder: FOLDER, title: 'x', created: 1, updated: 1 });
  assert.equal(reg.get('dashboard:chat-1'), null);
  assert.equal(isAppSessionSlot(mine, FOLDER), true);
  assert.equal(isAppSessionSlot(mine, '/other'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hideCopilotAgents: on hides the local harness, Cloud and Copilot CLI; off restores VS Code defaults', () => {
  const on = chatSettings();
  assert.equal(on['chat.editor.localAgent.enabled'], false);
  assert.equal(on['github.copilot.chat.cloudAgent.enabled'], false);
  assert.equal(on['github.copilot.chat.backgroundAgent.enabled'], false);
  assert.equal(on['chat.defaultToCopilotHarness'], false);
  assert.ok(!('chat.disableAIFeatures' in on), 'the Chat view stays enabled');
  const seeded = JSON.parse(seedThemeSettings('', null, on));
  const off = JSON.parse(seedThemeSettings(JSON.stringify(seeded), null, chatSettings({ hideCopilotAgents: false })));
  assert.equal(off['chat.editor.localAgent.enabled'], true);
  assert.ok(!('github.copilot.chat.cloudAgent.enabled' in off), 'Cloud goes back to its own default');
  assert.ok(!('github.copilot.chat.backgroundAgent.enabled' in off));
  assert.deepEqual(parseChatPrefs(''), { hideCopilotAgents: true });
  assert.deepEqual(parseChatPrefs('{"hideCopilotAgents":false}'), { hideCopilotAgents: false });
  assert.deepEqual(parseChatPrefs('{"hideCopilotAgents":"no"}'), { hideCopilotAgents: true });
});

test('router and bridge: session routes need the bridge secret; view and prefs events are kept', () => {
  for (const [m, p] of [['GET', '/api/bridge/sessions'], ['POST', '/api/bridge/sessions'], ['GET', '/api/bridge/sessions/history'], ['POST', '/api/bridge/approve'], ['POST', '/api/bridge/question']]) {
    assert.equal(matchRoute(m, p, null).auth, 'bridge', p);
  }
  for (const [m, p] of [['GET', '/api/chat/prefs'], ['POST', '/api/chat/prefs'], ['POST', '/api/chat/open-session']]) assert.equal(matchRoute(m, p, null).auth, 'proxy', p);
  for (const [m, p] of [['POST', '/api/crew/view'], ['POST', '/api/secret-probe']]) assert.equal(matchRoute(m, p, null).auth, 'proxy', p);
  const b = new Bridge();
  assert.equal(b.crewView, null);
  assert.ok(b.applyEvent({ type: 'crewView', resolved: true, visible: true }));
  assert.deepEqual({ ...b.crewView, at: undefined }, { resolved: true, visible: true, at: undefined });
  assert.ok(b.applyEvent({ type: 'crewView', resolved: true, visible: 'yes' }));
  assert.equal(b.crewView.visible, false, 'only a real boolean counts');
  assert.equal(b.applyEvent({ type: 'toggleCrewChat' }), false, 'the 0.4.0 column toggle event is gone');
  assert.ok(b.applyEvent({ type: 'chatPrefs', hideCopilotAgents: false }));
  assert.equal(b.chatPrefs.hideCopilotAgents, false);
  assert.equal(b.applyEvent({ type: 'chatPrefs', hideCopilotAgents: 'no' }), false);
  assert.ok(b.applyEvent({ type: 'chatSession', what: 'content', slot: 's', turns: 4 }));
  assert.deepEqual({ ...b.sessionEvents[0], at: 0 }, { what: 'content', slot: 's', turns: 4, detail: null, at: 0 });
  assert.equal(parseNativeChatRequest({ prompt: 'x', folder: FOLDER, slot: 'a b' }).error, 'slot is required');
  assert.equal(parseNativeChatRequest({ prompt: 'x', folder: FOLDER, slot: 'vscode-demo-1' }).slot, 'vscode-demo-1');
});

// ---------------------------------------------------------------- runNativeTurn against the mock

const nativeTurn = (g, prompt, { slot = 'vscode-demo-s1', parts = [], signal = new AbortController().signal, onPart } = {}) =>
  runNativeTurn({
    gateway: g, prompt, folder: FOLDER, slot, title: 'VS Code: t', signal, watchMs: 50,
    write: (p) => {
      parts.push(p);
      onPart?.(p);
    },
  });

test('runNativeTurn: a session slot of its own, streamed text, a tool card completed with its input and output', async () => {
  await withMock(async (mock, g) => {
    const parts = [];
    const r = await nativeTurn(g, 'say hi', { parts });
    assert.equal(r.outcome, 'done');
    assert.equal(mock.rec.turns[0].slot, 'vscode-demo-s1');
    assert.equal(mock.rec.slots.get('vscode-demo-s1').project, FOLDER);
    assert.deepEqual(parts[0], { kind: 'session', slot: 'vscode-demo-s1', native: true });
    assert.equal(parts.filter((p) => p.kind === 'markdown').map((p) => p.text).join(''), 'Hello from the **Kiro Crew mock**.');
    const tools = parts.filter((p) => p.kind === 'tool');
    assert.deepEqual(tools.map((t) => [t.id, t.state]), [['kc-tool-1', 'running'], ['kc-tool-1', 'done']]);
    assert.equal(tools[1].toolKind, 'read');
    assert.equal(tools[1].output, 'line one\nline two');
    const legacy = parts.find((p) => p.kind === 'approval');
    assert.equal(legacy.requestId, null);
    assert.equal(legacy.grant.granted, false, 'a pending row with no id cannot be answered in VS Code');
    assert.equal(parts.at(-1).kind, 'done');
  }, { defaultPermission: true });
});

test('runNativeTurn: an approval answered in VS Code reaches the gateway and the turn finishes', async () => {
  await withMock(async (mock, g) => {
    const parts = [];
    const run = nativeTurn(g, 'please approve me', {
      parts,
      onPart: (p) => {
        if (p.kind === 'approval') g.approve('vscode-demo-s1', { requestId: p.requestId, action: 'approved' });
      },
    });
    const r = await run;
    assert.equal(r.outcome, 'done');
    const card = parts.find((p) => p.kind === 'approval');
    assert.equal(card.requestId, 'req-1');
    assert.equal(card.input, 'npm test');
    assert.deepEqual(card.grant, { granted: true });
    assert.equal(mock.rec.approvals[0].action, 'approved');
    assert.ok(mock.rec.approvals[0].responseId, 'each decision carries a response id');
    assert.ok(parts.some((p) => p.kind === 'markdown' && /12 passing/.test(p.text)));
    const done = parts.filter((p) => p.kind === 'tool').at(-1);
    assert.equal(done.state, 'done');
    assert.equal(done.output, '12 passing');
  });
});

test('runNativeTurn: an approval decided in Kiro Crew clears the VS Code card', async () => {
  await withMock(async (mock, g) => {
    const parts = [];
    const r = await nativeTurn(g, 'approve me', {
      parts,
      onPart: (p) => {
        if (p.kind === 'approval') setTimeout(() => mock.resolveElsewhere(p.requestId, 'rejected'), 30);
      },
    });
    assert.equal(r.outcome, 'done');
    const cleared = parts.find((p) => p.kind === 'approvalResolved');
    assert.deepEqual(cleared, { kind: 'approvalResolved', requestId: 'req-1', resolved: 'rejected' });
    assert.equal(parts.filter((p) => p.kind === 'tool').at(-1).state, 'error');
  });
});

test('without permissions.sessionApproval the card says to approve in Kiro Crew, and approve reports the refusal', async () => {
  await withMock(async (mock, g) => {
    mock.setGrant(false, 'consent_pending');
    const parts = [];
    const run = nativeTurn(g, 'approve me', { parts });
    let card;
    for (let i = 0; i < 100 && !card; i++) {
      card = parts.find((p) => p.kind === 'approval');
      await sleep(20);
    }
    assert.equal(card.grant.granted, false);
    assert.equal(card.grant.cause, 'consent_pending');
    assert.match(card.grant.message, /sessionApproval/);
    const refused = await g.approve('vscode-demo-s1', { requestId: card.requestId, action: 'approved' });
    assert.deepEqual([refused.ok, refused.status, refused.code, refused.cause], [false, 403, 'session_approval_not_granted', 'consent_pending']);
    mock.resolveElsewhere(card.requestId, 'approved');
    assert.equal((await run).outcome, 'done');
  });
});

test('runNativeTurn: a blocking question is offered and its answer reaches the gateway', async () => {
  await withMock(async (mock, g) => {
    const parts = [];
    const r = await nativeTurn(g, 'ask me', {
      parts,
      onPart: (p) => {
        if (p.kind === 'question') g.answerQuestion('vscode-demo-s1', { askId: p.askId, answers: { [p.questions[0].question]: p.questions[0].options[1] } });
      },
    });
    assert.equal(r.outcome, 'done');
    const q = parts.find((p) => p.kind === 'question');
    assert.deepEqual(q.questions[0].options, ['Red', 'Blue']);
    assert.deepEqual(mock.rec.answers[0].answers, { 'Which colour?': 'Blue' });
    assert.ok(parts.some((p) => p.kind === 'questionResolved' && p.askId === q.askId) || parts.some((p) => p.kind === 'markdown' && /Blue/.test(p.text)));
  });
});

test('runNativeTurn: cancel stops the Kiro Crew turn; a closed session slot is recreated', async () => {
  await withMock(async (mock, g) => {
    const ac = new AbortController();
    const run = nativeTurn(g, 'be slow', { signal: ac.signal });
    await sleep(300);
    ac.abort();
    assert.equal((await run).outcome, 'cancelled');
    assert.deepEqual(mock.rec.stops, ['vscode-demo-s1']);
    mock.rec.closeBeforeNextSend = true;
    const r = await nativeTurn(g, 'again');
    assert.equal(r.outcome, 'done');
    assert.equal(mock.rec.slots.get('vscode-demo-s1').project, FOLDER);
  });
});

// ---------------------------------------------------------------- launcher with a stand-in server

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * A stand-in VS Code server build: node.exe (a link to this node) and an
 * out/server-main.js that answers /version and writes the bridge address and
 * secret it was given to bridge.json, so the test can play the extension.
 */
function fakeServerBuild(dir) {
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  const exe = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
  try {
    fs.linkSync(process.execPath, exe);
  } catch {
    fs.copyFileSync(process.execPath, exe);
  }
  fs.writeFileSync(
    path.join(dir, 'out', 'server-main.js'),
    `const http=require('http');const fs=require('fs');const path=require('path');
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
fs.writeFileSync(path.join(__dirname,'..','bridge.json'),JSON.stringify({url:process.env.KIROCREW_VSCODE_BRIDGE_URL,secret:process.env.KIROCREW_VSCODE_BRIDGE_SECRET}));
http.createServer((q,s)=>{s.writeHead(200);s.end('{}');}).listen(port,'127.0.0.1');`,
  );
}

test('launcher: native sessions, history, approvals, prefs and the crew chat toggle', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-native-'));
  const serverDir = path.join(dataDir, 'server');
  fakeServerBuild(serverDir);
  const workspace = path.join(dataDir, 'ws');
  fs.mkdirSync(workspace);
  const secret = crypto.randomBytes(16).toString('hex');
  const mock = createGatewayMock({ appName: 'vscode-pane', secret, defaultPermission: false });
  const origin = await mock.listen();
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'backend', 'launcher.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      KIROCREW_PROXY_SECRET: secret,
      KIROCREW_APP_NAME: 'vscode-pane',
      KIROCREW_GATEWAY_ORIGIN: origin,
      // Never the real Kiro Crew home: the launcher's local sign-in reads gateway secrets from it.
      KIROCREW_HOME: path.join(dataDir, 'no-kiro-crew-home'),
      VSCODE_PANE_DATA_DIR: path.join(dataDir, 'data'),
      VSCODE_PANE_SERVER_DIR: serverDir,
      VSCODE_PANE_WORKSPACE: workspace,
      VSCODE_PANE_NO_DOWNLOAD: '1',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  const proxy = async (method, p, body) => {
    const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signProxyRequest({ secret, ts, method, target: p, body: buf });
    const r = await fetch(base + p, { method, headers: { 'x-kirocrew-proxy': sig, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : buf });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  let br;
  const bridgeCall = async (method, p, body, host) => {
    const r = await fetch(base + p, { method, headers: { 'x-kiro-bridge-secret': br.secret, ...(host ? { 'x-kiro-bridge-host': host } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  try {
    for (let i = 0; i < 200 && !fs.existsSync(path.join(serverDir, 'bridge.json')); i++) await sleep(50);
    br = JSON.parse(fs.readFileSync(path.join(serverDir, 'bridge.json'), 'utf8'));
    assert.ok(br.secret && br.url, 'the stand-in server got the bridge address and secret');

    // V5 M-1: a webview origin (<uuid>.localhost on the frame port) gets only the
    // webview host files; the workbench, /vscode-remote-resource (any file) and
    // POSTs are 403, though the same paths work for the workbench's own host.
    let sess = null;
    for (let i = 0; i < 200 && !(sess && sess.url); i++) {
      sess = (await proxy('GET', '/api/session')).json;
      if (!(sess && sess.url)) await sleep(50);
    }
    const wb = new URL(sess.url);
    const key = wb.pathname.replace(/\/$/, '');
    const raw = (host, method, p) => new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: Number(wb.port), method, path: p, headers: { host, ...(method === 'POST' ? { 'content-length': '0' } : {}) } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      r.on('error', () => resolve(0));
      r.end();
    });
    const webview = `0a1b2c3d4e.localhost:${wb.port}`;
    const pre = `${key}/stable-abc/static/out/vs/workbench/contrib/webview/browser/pre/index.html?id=1`;
    assert.equal(await raw(webview, 'GET', pre), 200, 'webview host files load');
    for (const [m, p] of [['GET', `${key}/vscode-remote-resource?path=/C:/Users/x/secret.txt`], ['GET', `${key}/`], ['POST', pre],
      ['GET', `${key}/stable-abc/static/out/vs/workbench/contrib/webview/browser/pre/../../../../../../../../vscode-remote-resource?path=/x`],
      ['GET', `${key}/stable-abc/static/out/vs/code/browser/workbench/workbench.js`]]) {
      assert.equal(await raw(webview, m, p), 403, `${m} ${p.replace(key, '/vsc-<key>')}`);
    }
    assert.equal(await raw(`127.0.0.1:${wb.port}`, 'GET', `${key}/vscode-remote-resource?path=/x`), 200, 'the workbench itself still reaches it');
    // the extension says hello with this window's folder
    assert.equal((await bridgeCall('POST', '/api/bridge/events', { type: 'hello', host: 'h1', workspaceFolders: [workspace] })).status, 204);

    // Machine settings: Copilot agents hidden by default
    const machineFile = path.join(dataDir, 'data', 'server-data', 'data', 'Machine', 'settings.json');
    for (let i = 0; i < 100 && !fs.existsSync(machineFile); i++) await sleep(50);
    let machine = JSON.parse(fs.readFileSync(machineFile, 'utf8'));
    assert.equal(machine['chat.editor.localAgent.enabled'], false);
    assert.equal(machine['github.copilot.chat.cloudAgent.enabled'], false);

    // the crew view state for the page, and the tabs
    let s = (await proxy('GET', `/api/session?folder=${encodeURIComponent(workspace)}`)).json;
    assert.equal(s.crewView, null);
    assert.equal(s.crewChatToggle, undefined, 'no docked-column toggle counter any more');
    assert.equal(s.crewSlot, undefined, 'no per-folder session any more');
    assert.deepEqual([s.tabs.list.length, s.tabs.active, s.tabs.fresh], [0, null, true], 'a first run: no tab file yet');
    // Opening VS Code never creates a Kiro Crew session: a tab opened on its own
    // shows the session list in its Kiro Crew view, a chat's tab shows that chat.
    const slotsBefore = mock.rec.slots.size;
    const own = (await proxy('POST', '/api/tabs/open', { folder: workspace, reuse: true })).json;
    assert.match(own.tab.id, /^t[0-9a-f]{12}$/);
    assert.deepEqual([own.created, own.tab.folder, own.tab.session, own.tabs.active, own.tabs.fresh], [true, workspace, null, own.tab.id, false]);
    assert.equal((await proxy('POST', '/api/tabs/open', { folder: workspace, reuse: true })).json.tab.id, own.tab.id, '?folder= reuses the tab on that folder');
    let k = await bridgeCall('GET', `/api/bridge/kc?tab=${own.tab.id}`, undefined, 'h1');
    assert.equal(k.status, 200);
    assert.deepEqual([k.json.tab, k.json.session, k.json.embedPath], [own.tab.id, null, '/embed/sessions']);
    const chatTab = (await proxy('POST', '/api/tabs/open', { folder: workspace, session: 'dashboard:chat-1' })).json;
    assert.notEqual(chatTab.tab.id, own.tab.id, 'a chat gets its own tab, even on a folder that has one');
    assert.equal((await proxy('POST', '/api/tabs/open', { folder: path.dirname(workspace), session: 'dashboard:chat-1' })).json.tab.id, chatTab.tab.id, 'the chip again brings back the same tab');
    k = await bridgeCall('GET', `/api/bridge/kc?tab=${chatTab.tab.id}`, undefined, 'h1');
    assert.equal(k.json.embedPath, '/embed/chat/chat-1?sid=chat-1');
    assert.equal((await bridgeCall('GET', '/api/bridge/kc?tab=tffffffffffff', undefined, 'h1')).json.embedPath, '/embed/sessions', 'an unknown tab gets the session list');
    for (const bad of [{ folder: 'relative' }, { folder: path.join(workspace, 'missing') }, { session: 'x y' }, { session: '../x' }]) {
      assert.equal((await proxy('POST', '/api/tabs/open', bad)).status, 400, JSON.stringify(bad));
    }
    await sleep(300);
    assert.equal(mock.rec.slots.size, slotsBefore, 'no tab or Kiro Crew view request created a session');
    assert.equal((await proxy('POST', '/api/tabs/activate', { id: own.tab.id })).json.tabs.active, own.tab.id);
    assert.equal((await proxy('POST', '/api/tabs/activate', { id: 'tffffffffffff' })).status, 404);

    // The tunnel: the page sees only connected/not; the bridge gets the origin and embed URL.
    assert.deepEqual([s.kc.available, s.kc.connected], [true, false]);
    assert.equal(k.json.connected, false);
    assert.match(k.json.origin, /^http:\/\/[0-9a-f]{32}\.localhost:\d+$/);
    assert.equal(k.json.embedUrl, `${k.json.origin}/embed/chat/chat-1?sid=chat-1`);
    const signed = (await proxy('POST', '/api/kc/sign-in', { url: mock.mintLink(), via: 'auto' })).json;
    assert.equal(signed.ok, true);
    s = (await proxy('GET', '/api/session')).json;
    assert.equal(s.kc.connected, true);
    assert.equal(s.kc.via, 'auto');
    assert.ok(!JSON.stringify(s).includes(k.json.origin.slice(7, 39)), 'the tunnel origin is not in the page\'s session');
    assert.ok(!JSON.stringify(s).includes('mc_token'), 'no cookie in the page\'s session');
    const failed = (await proxy('POST', '/api/kc/sign-in', { error: 'external_origin_unavailable', via: 'connect' })).json;
    assert.equal(failed.kc.lastError, 'external_origin_unavailable');
    assert.equal(failed.kc.connected, true, 'a failed mint leaves the session as it was');
    assert.equal((await bridgeCall('POST', '/api/bridge/kc/connect', {}, 'h1')).json.connectRequests, 1);
    assert.equal((await proxy('GET', '/api/session')).json.kc.connectRequests, 1);
    assert.equal((await proxy('POST', '/api/kc/disconnect', {})).json.kc.connected, false);
    // V5 S-3: after Disconnect an automatic sign-in is refused (it would undo it
    // on the next dashboard reload); Connect or a paste still works.
    const st3 = (await proxy('GET', '/api/session')).json.kc;
    assert.equal(st3.userDisconnected, true);
    const autoAgain = await proxy('POST', '/api/kc/sign-in', { url: mock.mintLink(), via: 'auto' });
    assert.equal(autoAgain.status, 409);
    assert.equal(autoAgain.json.code, 'user_disconnected');
    assert.equal((await proxy('GET', '/api/session')).json.kc.connected, false);
    // V5 S-1: the page's reason for a refused mint is kept with its code for the setup note.
    const noUrl = (await proxy('POST', '/api/kc/sign-in', { error: 'no dashboard URL', code: 'external_origin_unavailable', via: 'connect' })).json;
    assert.equal(noUrl.kc.lastCode, 'external_origin_unavailable');
    const k2 = (await bridgeCall('GET', `/api/bridge/kc?tab=${own.tab.id}`, undefined, 'h1')).json;
    assert.notEqual(k2.origin, k.json.origin, 'Disconnect rotates the origin');
    assert.equal((await bridgeCall('POST', '/api/bridge/kc/sign-in', { url: mock.mintLink() }, 'h1')).json.ok, true, 'a pasted link signs in');
    assert.equal((await proxy('GET', '/api/session')).json.kc.via, 'paste');
    await bridgeCall('POST', '/api/bridge/events', { type: 'crewView', resolved: true, visible: true });
    s = (await proxy('GET', '/api/session')).json;
    assert.equal(s.crewView.visible, true);

    // two VS Code chat sessions -> two slots, both pointed at the folder
    const a = (await bridgeCall('POST', '/api/bridge/sessions', { folder: workspace, title: 'first' })).json.session;
    const b = (await bridgeCall('POST', '/api/bridge/sessions', { folder: workspace, title: 'second' })).json.session;
    assert.notEqual(a.slot, b.slot);
    assert.ok(a.slot.startsWith(slotNameFor(workspace) + '-'));
    assert.equal(mock.rec.slots.get(a.slot).project, workspace);
    assert.equal((await bridgeCall('POST', '/api/bridge/sessions', { folder: path.join(dataDir, 'elsewhere'), title: 'x' })).status, 403);
    assert.deepEqual((await bridgeCall('GET', '/api/bridge/sessions')).json.sessions.map((x) => x.slot).sort(), [a.slot, b.slot].sort());
    // The crew column lists them from GET /api/chat/slots under the app token: the app's own slots, project set.
    const listed = await new GatewayClient({ origin, appName: 'vscode-pane', secret }).json('GET', '/api/chat/slots');
    for (const x of [a, b]) {
      const row = listed.slots.find((r) => r.key === x.slot);
      assert.ok(row, `${x.slot} listed`);
      assert.equal(row.project, workspace);
      assert.match(row.title, /^VS Code: /);
    }

    // a native turn streams structured parts
    const t = await bridgeCall('POST', '/api/bridge/chat', { prompt: 'hello there', folder: workspace, slot: a.slot });
    const parts = t.text.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(parts[0], { kind: 'session', slot: a.slot, native: true });
    assert.ok(parts.some((p) => p.kind === 'tool' && p.state === 'done' && p.toolKind === 'read'));
    assert.equal(mock.rec.turns.at(-1).slot, a.slot);
    assert.equal((await bridgeCall('POST', '/api/bridge/chat', { prompt: 'x', folder: workspace, slot: 'not-ours' })).status, 404, 'only registered sessions');

    // S-4: a second VS Code window on another folder does not take the first
    // window's sessions away; each window is checked against its own folders.
    const other = path.join(dataDir, 'second window');
    fs.mkdirSync(other, { recursive: true });
    assert.equal((await bridgeCall('POST', '/api/bridge/events', { type: 'hello', host: 'h2', workspaceFolders: [other] })).status, 204);
    const h1Hist = await bridgeCall('GET', `/api/bridge/sessions/history?slot=${encodeURIComponent(a.slot)}`, undefined, 'h1');
    assert.equal(h1Hist.status, 200, 'window 1 still reaches its session after window 2 said hello');
    assert.equal((await bridgeCall('GET', `/api/bridge/sessions/history?slot=${encodeURIComponent(a.slot)}`, undefined, 'h2')).status, 404, 'window 2 cannot use window 1\'s session');
    assert.deepEqual((await bridgeCall('GET', '/api/bridge/sessions', undefined, 'h1')).json.sessions.map((x) => x.slot).sort(), [a.slot, b.slot].sort());
    assert.deepEqual((await bridgeCall('GET', '/api/bridge/sessions', undefined, 'h2')).json.sessions, []);
    assert.equal((await bridgeCall('POST', '/api/bridge/sessions', { folder: other, title: 'w2' }, 'h2')).status, 200, 'window 2 creates sessions in its own folder');
    assert.equal((await bridgeCall('POST', '/api/bridge/sessions', { folder: other, title: 'w2' }, 'h1')).status, 403);
    // A call that names no window may act on any live window's folders.
    assert.equal((await bridgeCall('GET', `/api/bridge/sessions/history?slot=${encodeURIComponent(a.slot)}`)).status, 200);

    // history comes back from the slot
    const h = (await bridgeCall('GET', `/api/bridge/sessions/history?slot=${encodeURIComponent(a.slot)}`)).json;
    assert.deepEqual(h.turns.map((x) => x.role), ['user', 'assistant']);
    assert.equal(h.turns[0].text, 'hello there');
    assert.ok(h.turns[1].parts.some((p) => p.kind === 'tool'));

    // an approval relayed through the launcher
    const approveRun = bridgeCall('POST', '/api/bridge/chat', { prompt: 'approve me', folder: workspace, slot: b.slot });
    let rid = null;
    for (let i = 0; i < 100 && !rid; i++) {
      rid = mock.pendingApprovals()[0] || null;
      await sleep(30);
    }
    const ap = (await bridgeCall('POST', '/api/bridge/approve', { slot: b.slot, requestId: rid, action: 'approved' })).json;
    assert.equal(ap.ok, true);
    const approveParts = (await approveRun).text.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(approveParts.some((p) => p.kind === 'approval' && p.requestId === rid && p.grant.granted === true));
    assert.equal(mock.rec.approvals.at(-1).action, 'approved');
    assert.equal((await bridgeCall('POST', '/api/bridge/approve', { slot: b.slot, requestId: rid, action: 'maybe' })).status, 400);

    // without the grant: a clear "approve in Kiro Crew" answer
    mock.setGrant(false);
    const run2 = bridgeCall('POST', '/api/bridge/chat', { prompt: 'approve me', folder: workspace, slot: b.slot });
    let rid2 = null;
    for (let i = 0; i < 100 && !rid2; i++) {
      rid2 = mock.pendingApprovals()[0] || null;
      await sleep(30);
    }
    const refused = (await bridgeCall('POST', '/api/bridge/approve', { slot: b.slot, requestId: rid2, action: 'approved' })).json;
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'session_approval_not_granted');
    assert.match(refused.message, /sessionApproval/);
    mock.resolveElsewhere(rid2, 'approved');
    const parts2 = (await run2).text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(parts2.find((p) => p.kind === 'approval').grant.granted, false);
    mock.setGrant(true);

    // the VS Code setting turned off brings Copilot's agents back (live Machine settings)
    await bridgeCall('POST', '/api/bridge/events', { type: 'chatPrefs', hideCopilotAgents: false });
    machine = JSON.parse(fs.readFileSync(machineFile, 'utf8'));
    assert.equal(machine['chat.editor.localAgent.enabled'], true);
    assert.ok(!('github.copilot.chat.cloudAgent.enabled' in machine));
    const prefs = (await proxy('GET', '/api/chat/prefs')).json;
    assert.equal(prefs.prefs.hideCopilotAgents, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'state', 'chat-prefs.json'), 'utf8')).hideCopilotAgents, false);
    const status = (await proxy('GET', '/api/chat/status')).json;
    assert.equal(status.native.sessions, 3, 'two in window 1, one in window 2');
    assert.equal(status.native.prefs.hideCopilotAgents, false);
  } finally {
    child.kill();
    await new Promise((ok) => (child.exitCode !== null ? ok() : child.once('exit', ok)));
    await mock.close();
    await sleep(200);
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
