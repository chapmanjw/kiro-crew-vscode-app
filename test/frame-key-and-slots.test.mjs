// Per-run frame key and run id, chat slots that were closed in Kiro Crew,
// unapproved chat permissions after an Update, and the bridge's folder pin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GatewayClient, PERMISSION_MESSAGE, slotNameFor, isScopeDenied } from '../backend/lib/gateway.mjs';
import { runChatTurn, folderInRoots } from '../backend/lib/chatbridge.mjs';
import { signProxyRequest } from '../backend/lib/auth.mjs';
import { createGatewayMock } from './support/gateway-mock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FOLDER = process.platform === 'win32' ? 'C:\\work\\demo' : '/work/demo';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withMock(fn) {
  const mock = createGatewayMock({ appName: 'vscode-pane', secret: 's3cret' });
  const origin = await mock.listen();
  try {
    await fn(mock, origin, new GatewayClient({ origin, appName: 'vscode-pane', secret: 's3cret' }));
  } finally {
    await mock.close();
  }
}
const turn = (g, prompt, parts = []) =>
  runChatTurn({ gateway: g, prompt, folder: FOLDER, signal: new AbortController().signal, write: (p) => parts.push(p) });

// ---------------------------------------------------------------- slots

test('a slot closed in Kiro Crew is recreated with its project on the next turn', async () => {
  await withMock(async (mock, _origin, g) => {
    const key = slotNameFor(FOLDER);
    assert.equal((await turn(g, 'first')).outcome, 'done');
    mock.closeSlot(key);
    const parts = [];
    const r = await turn(g, 'second', parts);
    assert.equal(r.outcome, 'done', JSON.stringify(parts.filter((p) => p.kind === 'error')));
    assert.equal(r.slot, key);
    assert.equal(mock.rec.slots.get(key).project, FOLDER, 'the recreated slot has the folder as its project');
    assert.deepEqual(mock.rec.projects.map((p) => p.project), [FOLDER, FOLDER]);
    assert.deepEqual(mock.rec.turns.map((t) => t.message), ['first', 'second']);
  });
});

test('a slot that disappears between create and send is recreated and the turn sent once more', async () => {
  await withMock(async (mock, _origin, g) => {
    mock.rec.closeBeforeNextSend = true;
    const parts = [];
    const r = await turn(g, 'raced', parts);
    assert.equal(r.outcome, 'done', JSON.stringify(parts.filter((p) => p.kind === 'error')));
    assert.deepEqual(mock.rec.turns.map((t) => t.message), ['raced']);
    assert.equal(mock.rec.slots.get(r.slot).project, FOLDER);
    assert.equal(parts.filter((p) => p.kind === 'error').length, 0);
  });
});

test('an open slot whose project is already set is not re-pointed on every turn', async () => {
  await withMock(async (mock, _origin, g) => {
    await turn(g, 'a');
    await turn(g, 'b');
    assert.equal(mock.rec.projects.length, 1);
  });
});

// ---------------------------------------------------------------- permissions

test('the gateway out-of-scope 403 is reported as unapproved permissions, and clears once approved', async () => {
  assert.equal(isScopeDenied(403, { error: 'app token not permitted for this endpoint', code: 'forbidden' }), true);
  assert.equal(isScopeDenied(403, { error: 'invalid token' }), false);
  assert.equal(isScopeDenied(404, { error: 'app token not permitted for this endpoint' }), false);
  await withMock(async (mock, _origin, g) => {
    mock.deny(['/api/chat', '/api/status']);
    await assert.rejects(g.status(), (e) => e.code === 'permission' && e.message === PERMISSION_MESSAGE);
    assert.equal(g.permissionDenied.path, '/api/status');
    const parts = [];
    const r = await turn(g, 'hi', parts);
    assert.equal(r.outcome, 'error');
    assert.match(parts.at(-1).text, /approve the new API permissions/);
    assert.match(parts.at(-1).text, /\/api\/chat, \/api\/chat\/slots, \/api\/status/);
    mock.deny([]);
    assert.equal((await turn(g, 'hi again')).outcome, 'done');
    assert.equal(g.permissionDenied, null);
  });
});

// ---------------------------------------------------------------- folder pin

test('folderInRoots allows only open workspace folders and their subfolders', () => {
  const w = { win: true };
  assert.equal(folderInRoots('C:\\Work\\Demo', ['c:\\work\\demo'], w), true);
  assert.equal(folderInRoots('C:\\work\\demo\\src', ['C:\\work\\demo\\'], w), true);
  assert.equal(folderInRoots('C:\\work\\demo2', ['C:\\work\\demo'], w), false);
  assert.equal(folderInRoots('C:\\work\\demo\\..\\other', ['C:\\work\\demo'], w), false);
  assert.equal(folderInRoots('D:\\x', ['C:\\'], w), false);
  assert.equal(folderInRoots('C:\\x', ['C:\\'], w), true);
  assert.equal(folderInRoots('C:\\work\\demo', [], w), false);
  const p = { win: false };
  assert.equal(folderInRoots('/work/demo/a', ['/work/demo'], p), true);
  assert.equal(folderInRoots('/Work/demo', ['/work/demo'], p), false);
  assert.equal(folderInRoots('/work/demox', ['/work/demo'], p), false);
});

// ---------------------------------------------------------------- launcher

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

async function startLauncher({ dataDir, secret, gatewayOrigin }) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'backend', 'launcher.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      KIROCREW_PROXY_SECRET: secret,
      KIROCREW_APP_NAME: 'vscode-pane',
      KIROCREW_GATEWAY_ORIGIN: gatewayOrigin,
      // Never the real Kiro Crew home: the launcher's local sign-in reads gateway secrets from it.
      KIROCREW_HOME: path.join(dataDir, 'no-kiro-crew-home'),
      VSCODE_PANE_DATA_DIR: dataDir,
      VSCODE_PANE_SERVER_DIR: path.join(dataDir, 'no-server'),
      VSCODE_PANE_NO_DOWNLOAD: '1',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const get = async (p) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signProxyRequest({ secret, ts, method: 'GET', target: p, body: Buffer.alloc(0) });
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { 'x-kirocrew-proxy': sig } });
    return r.json();
  };
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) break;
    await sleep(100);
  }
  const stop = async () => {
    child.kill();
    await new Promise((ok) => (child.exitCode !== null ? ok() : child.once('exit', ok)));
  };
  return { get, stop };
}

test('launcher: a new run id and frame key each run, only the port on disk, and chat 403 surfaced', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-m2-'));
  const secret = crypto.randomBytes(16).toString('hex');
  const mock = createGatewayMock({ appName: 'vscode-pane', secret });
  const origin = await mock.listen();
  mock.deny(['/api/chat', '/api/status']);
  const frameFile = path.join(dataDir, 'state', 'frame.json');
  fs.mkdirSync(path.dirname(frameFile), { recursive: true });
  const legacyKey = 'L'.repeat(24);
  fs.writeFileSync(frameFile, JSON.stringify({ key: legacyKey, port: await freePort() }));
  const runs = [];
  try {
    for (let i = 0; i < 2; i++) {
      const l = await startLauncher({ dataDir, secret, gatewayOrigin: origin });
      try {
        let s = await l.get('/api/session');
        for (let t = 0; t < 50 && !s.chat; t++) {
          await sleep(100);
          s = await l.get('/api/session');
        }
        const log = fs.readFileSync(path.join(dataDir, 'logs', 'launcher.log'), 'utf8');
        runs.push({ instance: s.instance, chat: s.chat, status: await l.get('/api/chat/status'), saved: JSON.parse(fs.readFileSync(frameFile, 'utf8')), log });
      } finally {
        await l.stop();
      }
    }
  } finally {
    await mock.close();
  }
  for (const r of runs) {
    assert.match(r.instance || '', /^[A-Za-z0-9_-]{8,}$/);
    assert.deepEqual(Object.keys(r.saved), ['port'], 'frame.json keeps the port only');
    assert.ok(!r.log.includes(legacyKey));
    assert.equal(r.chat && r.chat.code, 'permission');
    assert.match(r.chat.message, /approve the new API permissions/);
    assert.equal(r.status.available, false);
    assert.equal(r.status.permission.denied, true);
    assert.deepEqual(r.status.permission.needed, ['/api/chat', '/api/chat/slots', '/api/status']);
  }
  assert.notEqual(runs[0].instance, runs[1].instance, 'each launcher run has its own id');
  fs.rmSync(dataDir, { recursive: true, force: true });
});
