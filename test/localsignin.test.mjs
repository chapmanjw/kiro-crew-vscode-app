// The launcher against the mock gateway, signing the Kiro Crew tab in with the
// gateway's local token (backend/lib/localtoken.mjs) when the page cannot
// mint a link: at start, after the page reports a refused mint, on a Connect
// press that overrides Disconnect, and never to a gateway whose secret the
// launcher cannot read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signProxyRequest } from '../backend/lib/auth.mjs';
import { createGatewayMock } from './support/gateway-mock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function run(t, { writeSecret = true, localSecret = 'local-owner-secret', fileSecret = localSecret } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-ls-'));
  const secret = crypto.randomBytes(16).toString('hex');
  const mock = createGatewayMock({ appName: 'vscode-pane', secret });
  const origin = await mock.listen();
  const gwPort = new URL(origin).port;
  mock.rec.dash.localSecret = localSecret;
  const kcHome = path.join(dir, 'kiro-crew-home');
  if (writeSecret) {
    fs.mkdirSync(path.join(kcHome, 'run'), { recursive: true });
    fs.writeFileSync(path.join(kcHome, 'run', `gateway-${gwPort}-127.0.0.1.secret`), fileSecret);
  }
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'backend', 'launcher.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      KIROCREW_PROXY_SECRET: secret,
      KIROCREW_APP_NAME: 'vscode-pane',
      KIROCREW_GATEWAY_ORIGIN: origin,
      KIROCREW_HOME: kcHome,
      VSCODE_PANE_DATA_DIR: path.join(dir, 'data'),
      VSCODE_PANE_SERVER_DIR: path.join(dir, 'no-server'),
      VSCODE_PANE_NO_DOWNLOAD: '1',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  t.after(async () => {
    child.kill();
    await new Promise((ok) => (child.exitCode !== null ? ok() : child.once('exit', ok)));
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const proxy = async (method, p, body) => {
    const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signProxyRequest({ secret, ts, method, target: p, body: buf });
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-kirocrew-proxy': sig, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : buf });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) break;
    await sleep(100);
  }
  const kcState = async (until) => {
    let kc = null;
    for (let i = 0; i < 60; i++) {
      kc = (await proxy('GET', '/api/session')).json?.kc;
      if (kc && until(kc)) break;
      await sleep(100);
    }
    return kc;
  };
  return { mock, proxy, kcState, dir };
}

test('the launcher signs the tab in at start with the gateway\'s local token', async (t) => {
  const l = await run(t);
  const kc = await l.kcState((k) => k.connected);
  assert.equal(kc.connected, true);
  assert.equal(kc.via, 'local');
  assert.equal(kc.lastError, null);
  assert.equal(l.mock.rec.dash.localMints, 1);
  assert.deepEqual(l.mock.rec.dash.forbiddenHits, []);
  const log = fs.readFileSync(path.join(l.dir, 'data', 'logs', 'launcher.log'), 'utf8');
  assert.match(log, /kc local sign-in via local ok/);
  assert.ok(!log.includes('local-owner-secret'), 'the secret is never logged');
  assert.ok(!JSON.stringify(kc).includes('local-owner-secret'));
});

test('after a Disconnect only Connect signs in again, and a refused page mint falls back to the local token', async (t) => {
  const l = await run(t);
  await l.kcState((k) => k.connected);
  assert.equal((await l.proxy('POST', '/api/kc/disconnect', {})).status, 200);
  let kc = await l.kcState((k) => !k.connected);
  assert.equal(kc.connected, false);
  assert.equal(kc.userDisconnected, true);
  // The page's automatic mint fails while the user has disconnected: no sign-in.
  const auto = await l.proxy('POST', '/api/kc/sign-in', { error: 'the dashboard refused a sign-in link: governance_denied', code: 'governance_denied', via: 'auto' });
  assert.equal(auto.status, 200);
  assert.equal(auto.json.ok, false);
  assert.equal(auto.json.kc.connected, false);
  assert.equal(l.mock.rec.dash.localMints, 1, 'no second mint');
  // The user's Connect press whose page mint failed: the local token signs in.
  const connect = await l.proxy('POST', '/api/kc/sign-in', { error: 'the dashboard refused a sign-in link: governance_denied', code: 'governance_denied', via: 'connect' });
  assert.equal(connect.json.ok, false, 'the page\'s own sign-in did not happen');
  kc = await l.kcState((k) => k.connected);
  assert.equal(kc.connected, true);
  assert.equal(kc.userDisconnected, false);
  assert.equal(kc.lastError, null);
  assert.equal(l.mock.rec.dash.localMints, 2);
});

test('a gateway secret the launcher cannot read leaves the page\'s own message and the paste field', async (t) => {
  const l = await run(t, { writeSecret: false });
  const kc = await l.kcState((k) => k.local && k.local.attempts >= 1 && !k.local.lastOkAt);
  assert.equal(kc.connected, false);
  assert.equal(kc.local.lastCode, 'local_secret_unavailable');
  assert.equal(l.mock.rec.dash.localMints, 0);
  const page = await l.proxy('POST', '/api/kc/sign-in', { error: 'This Kiro Crew has no dashboard URL (external_origin_unavailable).', code: 'external_origin_unavailable', via: 'auto' });
  assert.equal(page.json.kc.lastCode, 'external_origin_unavailable', 'the page\'s hint survives a failed local sign-in');
  assert.match(page.json.kc.lastError, /no dashboard URL/);
  assert.equal(page.json.kc.connected, false);
});

test('a wrong gateway secret is refused by the gateway and reported without the secret', async (t) => {
  const l = await run(t, { localSecret: 'the-real-secret', fileSecret: 'a-stale-secret' });
  const kc0 = await l.kcState((k) => k.local && k.local.attempts >= 1 && !k.local.lastOkAt);
  assert.equal(kc0.connected, false, 'the start-up attempt was refused by the gateway');
  assert.equal(kc0.local.lastCode, 'invalid_secret');
  assert.match(kc0.lastError, /^local sign-in: /);
  const page = await l.proxy('POST', '/api/kc/sign-in', { error: 'refused', code: 'governance_denied', via: 'connect' });
  assert.equal(page.json.kc.connected, false);
  assert.equal(page.json.kc.local.lastCode, 'invalid_secret');
  assert.equal(page.json.kc.lastCode, 'governance_denied', 'the page\'s report stays');
  assert.equal(l.mock.rec.dash.localDenied, 2);
  assert.ok(!JSON.stringify(page.json).includes('a-stale-secret'));
  assert.ok(!JSON.stringify(page.json).includes('the-real-secret'));
});
