// The launcher's own sign-in (backend/lib/localtoken.mjs): the gateway secret
// read the way the gateway's clients read it for a dial to 127.0.0.1, the
// GET /api/token/local mint, and the trade of that token for a tunnel session
// against the mock gateway's dashboard side (test/support/dashboard-mock.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { dataHome, readLocalSecret, mintLocalToken, signInWithLocalToken, LOCAL_TOKEN_TTL } from '../backend/lib/localtoken.mjs';
import { createKcProxy } from '../backend/lib/kcproxy.mjs';
import { tunnelCss } from '../backend/lib/chipcss.mjs';
import { createGatewayMock } from './support/gateway-mock.mjs';

function home(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-lt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('dataHome: KIROCREW_HOME, else ~/.kiro/crew', () => {
  assert.equal(dataHome({ KIROCREW_HOME: 'D:\\kc' }, 'C:\\Users\\u'), 'D:\\kc');
  assert.equal(dataHome({ KIROCREW_HOME: '  ' }, '/home/u'), path.join('/home/u', '.kiro', 'crew'));
  assert.equal(dataHome({}, ''), '');
});

test('readLocalSecret: the listener entry for 127.0.0.1 wins, and the wildcard bind covers it', (t) => {
  const a = home(t, { 'run/gateway-5476-127.0.0.1.secret': 'live\n', 'run/gateway-5476.secret': 'other', '.local_secret': 'shared' });
  assert.deepEqual(readLocalSecret({ home: a, port: 5476 }), { secret: 'live', reason: '' });
  const b = home(t, { 'run/gateway-5476-0.0.0.0.secret': 'wild' });
  assert.equal(readLocalSecret({ home: b, port: 5476 }).secret, 'wild');
  const both = home(t, { 'run/gateway-5476-0.0.0.0.secret': 'same', 'run/gateway-5476-127.0.0.1.secret': 'same' });
  assert.equal(readLocalSecret({ home: both, port: 5476 }).secret, 'same');
});

test('readLocalSecret: refuses what the gateway\'s own readers refuse', (t) => {
  // Entries exist for another address only (v6 only): the port file is another listener's, so nothing goes out.
  const v6 = home(t, { 'run/gateway-5476-__1.secret': 'six', 'run/gateway-5476.secret': 'six', '.local_secret': 'six' });
  const r6 = readLocalSecret({ home: v6, port: 5476 });
  assert.equal(r6.secret, '');
  assert.match(r6.reason, /none for 127\.0\.0\.1/);
  // A stale entry beside the live one: two values, no way to tell which is live.
  const stale = home(t, { 'run/gateway-5476-0.0.0.0.secret': 'old', 'run/gateway-5476-127.0.0.1.secret': 'new' });
  assert.match(readLocalSecret({ home: stale, port: 5476 }).reason, /conflicting/);
  // Another port's entries do not count.
  const other = home(t, { 'run/gateway-9999-127.0.0.1.secret': 'x', 'run/gateway-5476.secret': 'port-file' });
  assert.equal(readLocalSecret({ home: other, port: 5476 }).secret, 'port-file');
  // An unreadable run directory leaves absence unproven.
  const unreadable = { readdirSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); }, readFileSync: () => 'secret' };
  assert.match(readLocalSecret({ home: '/h', port: 5476, fs: unreadable }).reason, /could not read/);
  for (const bad of [0, 70000, 1.5, 'x', undefined]) assert.equal(readLocalSecret({ home: '/h', port: bad }).secret, '', String(bad));
  assert.equal(readLocalSecret({ home: '', port: 5476 }).secret, '');
});

test('readLocalSecret: an older gateway falls back to its port file, and never to the home-wide file', (t) => {
  const port = home(t, { 'run/gateway-5476.secret': 'p', '.local_secret': 's' });
  assert.equal(readLocalSecret({ home: port, port: 5476 }).secret, 'p');
  const shared = home(t, { '.local_secret': 's\r\n' });
  const r = readLocalSecret({ home: shared, port: 5476 });
  assert.equal(r.secret, '');
  assert.match(r.reason, /no gateway secret for port 5476/);
});

async function setup(t) {
  const mock = createGatewayMock({ secret: 's' });
  const gw = new URL(await mock.listen());
  const gwPort = Number(gw.port);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-lt-kc-'));
  const lines = [];
  const kc = createKcProxy({ gatewayPort: gwPort, stateFile: path.join(dir, 'kc-session.json'), css: tunnelCss(), log: (l) => lines.push(l), frameAncestors: () => ['http://127.0.0.1:4100'] });
  await kc.listen();
  t.after(async () => {
    await kc.close();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { mock, kc, gwPort, lines };
}

test('sign in with the local token: secret on disk, token minted on loopback, session held by the tunnel', async (t) => {
  const { mock, kc, gwPort, lines } = await setup(t);
  mock.rec.dash.localSecret = 'the-local-secret';
  const h = home(t, { [`run/gateway-${gwPort}-127.0.0.1.secret`]: 'the-local-secret' });
  assert.equal(kc.status().connected, false);
  const r = await signInWithLocalToken({ env: { KIROCREW_HOME: h }, homedir: '', port: gwPort, signIn: (tok) => kc.signIn(tok) });
  assert.deepEqual(r, { ok: true });
  assert.equal(kc.status().connected, true);
  assert.equal(mock.rec.dash.localMints, 1);
  assert.deepEqual(mock.rec.dash.localTtls, [LOCAL_TOKEN_TTL]);
  assert.equal(mock.rec.dash.exchanges, 1);
  assert.deepEqual(mock.rec.dash.forbiddenHits, []);
  const log = lines.join('\n');
  assert.ok(!log.includes('the-local-secret'), 'the secret is never logged');
});

test('sign in with the local token: a wrong secret, a missing secret and a dead gateway each say why', async (t) => {
  const { mock, kc, gwPort } = await setup(t);
  mock.rec.dash.localSecret = 'right';
  const wrong = home(t, { [`run/gateway-${gwPort}-127.0.0.1.secret`]: 'wrong' });
  const a = await signInWithLocalToken({ env: { KIROCREW_HOME: wrong }, homedir: '', port: gwPort, signIn: (tok) => kc.signIn(tok) });
  assert.equal(a.ok, false);
  assert.equal(a.code, 'invalid_secret');
  assert.ok(!JSON.stringify(a).includes('wrong'), 'the secret is not echoed');
  assert.equal(mock.rec.dash.localDenied, 1);
  assert.equal(kc.status().connected, false);
  const none = home(t);
  const b = await signInWithLocalToken({ env: { KIROCREW_HOME: none }, homedir: '', port: gwPort, signIn: (tok) => kc.signIn(tok) });
  assert.equal(b.code, 'local_secret_unavailable');
  const c = await mintLocalToken({ port: 1, secret: 'x', timeoutMs: 2000 });
  assert.equal(c.ok, false);
  assert.equal(c.status, 0);
});

test('sign in with the local token: a token the tunnel cannot exchange is reported, and an earlier session survives', async (t) => {
  const { mock, kc, gwPort } = await setup(t);
  mock.rec.dash.localSecret = 's';
  const h = home(t, { [`run/gateway-${gwPort}-127.0.0.1.secret`]: 's' });
  const first = await signInWithLocalToken({ env: { KIROCREW_HOME: h }, homedir: '', port: gwPort, signIn: (tok) => kc.signIn(tok) });
  assert.equal(first.ok, true);
  const bad = await signInWithLocalToken({ env: { KIROCREW_HOME: h }, homedir: '', port: gwPort, signIn: async () => ({ ok: false, error: 'HTTP 401' }) });
  assert.deepEqual(bad, { ok: false, code: 'local_token_exchange_failed', error: 'HTTP 401' });
  assert.equal(kc.status().connected, true);
});

test('the tunnel still refuses /api/token/local from the page, whatever the launcher does', async (t) => {
  const { kc } = await setup(t);
  const host = new URL(kc.origin).host;
  const status = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: kc.port, method: 'GET', path: '/api/token/local', headers: { host, 'x-local-secret': 'anything' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject);
    r.end();
  });
  assert.equal(status, 403);
});
