// The Kiro Crew tunnel (backend/lib/kcproxy.mjs) against the mock gateway's
// dashboard side (test/support/dashboard-mock.mjs): the host gate and CSRF
// boundary, sign-in by link, the session kept out of the browser and persisted
// owner-only, the frame header rewrite and chip stylesheet, the deny list,
// /sw.js, one refresh at a time, the WebSocket, restart persistence and
// Disconnect.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createKcProxy, denied, linkToken, captureCookies, withFrameAncestors, jwtExp, DENY } from '../backend/lib/kcproxy.mjs';
import { chipHideCss } from '../backend/lib/chipcss.mjs';
import { createGatewayMock } from './support/gateway-mock.mjs';

function req(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

function wsOpen(port, host, origin, p = '/api/ws?caps=x') {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`GET ${p} HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    const done = () => {
      s.destroy();
      resolve(buf.toString('latin1'));
    };
    s.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (/hello from the mock gateway|403/.test(buf.toString('latin1'))) done();
    });
    s.on('error', done);
    setTimeout(done, 3000);
  });
}

async function setup(t, opts = {}) {
  const mock = createGatewayMock({ secret: 's' });
  const gw = new URL(await mock.listen());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-kc-'));
  const stateFile = opts.stateFile || path.join(dir, 'kc-session.json');
  const lines = [];
  const kc = createKcProxy({
    gatewayPort: Number(gw.port), stateFile, css: chipHideCss(), log: (l) => lines.push(l),
    frameAncestors: () => ['http://localhost:5476', 'http://127.0.0.1:4100', 'http://*.localhost:4100'],
    restrict: opts.restrict,
  });
  await kc.listen(opts.port);
  const host = new URL(kc.origin).host;
  const H = (extra = {}) => ({ host, ...extra });
  t.after(async () => {
    await kc.close();
    await mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { mock, kc, host, H, origin: kc.origin, stateFile, lines, dir };
}

test('helpers: deny list with path tricks, link tokens, cookie capture, frame-ancestors, jwt exp', () => {
  for (const p of ['/api/token/local', '/API/Token/Local', '//api/token/local', '/api/%74oken/local', '/api/./token/local', '/api/x/../token/local', '/api/auth/mobile-link?x=1',
    '/api/tailnet/qr', '/api/instances/abc/embed-token', '/api/apps/vscode-pane/token', '/api/webhooks/tokens', '/api/relay-viewer/token', '/api/secrets', '/api/secrets/x', '/api/logout', '/api/%zz']) {
    assert.equal(denied(p), true, p);
  }
  for (const p of ['/', '/embed/chat/x', '/api/auth/me?token=abc', '/api/auth/refresh', '/api/auth/logout', '/api/chat/slots', '/assets/a.js']) assert.equal(denied(p), false, p);
  assert.ok(DENY.length >= 9);
  const tok = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.sig_part-1234';
  assert.equal(linkToken(`http://localhost:5476/?token=${tok}`), tok);
  assert.equal(linkToken(tok), tok);
  for (const bad of ['', 'http://localhost/?x=1', 'short', 'a b c d e f g h i j k l m n o p', 'javascript:alert(1)']) assert.equal(linkToken(bad), null, bad);
  const s = { token: '', refresh: '' };
  assert.equal(captureCookies(['mc_token_4000=AAA; Path=/; HttpOnly', 'mc_refresh_4000=RRR; Path=/api/auth', 'other=1'], s), true);
  assert.deepEqual(s, { token: 'AAA', refresh: 'RRR' });
  assert.equal(captureCookies(['mc_token_4000=; Path=/; Max-Age=0'], s), true);
  assert.equal(s.token, '');
  assert.equal(withFrameAncestors("default-src 'self'; frame-ancestors 'self'", ['http://a', 'http://b']), "default-src 'self'; frame-ancestors http://a http://b");
  assert.equal(withFrameAncestors('', ['http://a']), 'frame-ancestors http://a');
  assert.equal(jwtExp('x.' + Buffer.from('{"exp":123}').toString('base64url') + '.y'), 123);
  assert.equal(jwtExp('garbage'), 0);
});

test('gate: only the secret *.localhost host, same-origin, and an Origin on every mutating request', async (t) => {
  const { kc, H, origin, host } = await setup(t);
  assert.match(origin, /^http:\/\/[0-9a-f]{32}\.localhost:\d+$/);
  assert.equal((await req(kc.port, { headers: { host: `127.0.0.1:${kc.port}` } })).status, 421, 'bare loopback host');
  assert.equal((await req(kc.port, { headers: { host: `${'0'.repeat(32)}.localhost:${kc.port}` } })).status, 421, 'wrong label');
  assert.equal((await req(kc.port, { headers: H({ origin: 'http://localhost:5476' }) })).status, 403, 'foreign Origin');
  assert.equal((await req(kc.port, { method: 'POST', path: '/api/auth/logout', headers: H() })).status, 403, 'mutating without Origin');
  assert.equal((await req(kc.port, { headers: H() })).status, 200);
  assert.equal(host.split(':')[1], String(kc.port));
});

test('sign-in by link: the session stays in the launcher, owner-only on disk, never in the browser', async (t) => {
  const { kc, mock, H, origin, stateFile } = await setup(t);
  assert.equal(kc.status().connected, false);
  assert.match((await req(kc.port, { path: '/api/auth/me', headers: H() })).body, /unauthenticated/);
  const link = mock.mintLink();
  const r = await kc.signIn(link);
  assert.deepEqual(r, { ok: true, status: 200 });
  const st = kc.status();
  assert.equal(st.connected, true);
  assert.equal(st.canRefresh, true);
  assert.ok(Date.parse(st.accessExpiresAt) > Date.now());
  assert.ok(!JSON.stringify(st).includes(mock.rec.dash.sessions.keys().next().value), 'status carries no cookie value');
  // The browser-facing response has no Set-Cookie, yet the request is authenticated.
  const me = await req(kc.port, { path: '/api/auth/me', headers: H() });
  assert.equal(me.status, 200);
  assert.equal(me.headers['set-cookie'], undefined);
  // A browser cookie is never forwarded.
  const spoof = await req(kc.port, { path: '/api/auth/me', headers: H({ cookie: `mc_token_${kc.port}=forged` }) });
  assert.equal(spoof.status, 200, 'the launcher’s cookie is used, the browser’s dropped');
  // Persisted, owner-only.
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(saved.token && saved.refresh && saved.label && saved.port === kc.port);
  if (process.platform !== 'win32') assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  // Single use: the same link again is refused, and the earlier session survives.
  const again = await kc.signIn(link);
  assert.equal(again.ok, false);
  assert.equal(kc.status().connected, true);
  assert.equal((await kc.signIn('not a link')).status, 400);
  assert.equal(mock.rec.dash.exchanges, 1);
  assert.ok(origin);
});

test('pages through the tunnel: frame headers rewritten, chip stylesheet added, request marked as proxied', async (t) => {
  const { kc, mock, H } = await setup(t);
  await kc.signIn(mock.mintLink());
  const x0 = mock.rec.dash.xff;
  const page = await req(kc.port, { path: '/embed/chat/vscode-x-1', headers: H() });
  assert.equal(page.status, 200);
  assert.equal(page.headers['x-frame-options'], undefined);
  assert.equal(page.headers['strict-transport-security'], undefined);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.match(page.headers['content-security-policy'], /frame-ancestors http:\/\/localhost:5476 http:\/\/127\.0\.0\.1:4100 http:\/\/\*\.localhost:4100$/);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/, 'the rest of the CSP is kept');
  assert.match(page.body, /<style id="kc-vscode-pane">button\[data-session-control-chip\]:has\(svg\.lucide-package\)/);
  assert.equal(page.headers['content-length'], String(Buffer.byteLength(page.body)));
  assert.ok(mock.rec.dash.xff > x0, 'X-Forwarded-For reached the gateway');
  assert.equal(mock.rec.dash.badOrigin, 0, 'Host and Origin rewritten to the same-origin loopback form');
});

test('credential-minting routes and /sw.js never reach the gateway', async (t) => {
  const { kc, mock, H, origin } = await setup(t);
  await kc.signIn(mock.mintLink());
  for (const p of ['/api/token/local', '/api/auth/mobile-link', '//api/token/local', '/api/%74oken/local', '/api/tailnet/qr', '/api/logout']) {
    const r = await req(kc.port, { method: 'POST', path: p, headers: H({ origin }) });
    assert.equal(r.status, 403, p);
    assert.match(r.body, /kc_tunnel_denied/, p);
  }
  assert.deepEqual(mock.rec.dash.forbiddenHits, []);
  assert.equal((await req(kc.port, { path: '/sw.js', headers: H() })).status, 404);
  assert.match(await wsOpen(kc.port, new URL(origin).host, origin, '/api/token/local'), /403/);
});

test('two refreshes at once run one after the other, so the chain is not revoked', async (t) => {
  const { kc, mock, H, origin } = await setup(t);
  await kc.signIn(mock.mintLink());
  const [a, b] = await Promise.all([1, 2].map(() => req(kc.port, { method: 'POST', path: '/api/auth/refresh', headers: H({ origin, 'content-length': '0' }) })));
  assert.equal(a.status, 200);
  assert.equal(b.status, 200, 'the second carried the rotated cookie');
  assert.equal(mock.rec.dash.maxRefreshInFlight, 1);
  assert.equal(mock.rec.dash.reuse, 0);
  assert.equal(a.headers['set-cookie'], undefined);
  assert.equal((await kc.refresh()).ok, true, 'the launcher refreshes through the same queue');
  assert.equal((await req(kc.port, { path: '/api/auth/me', headers: H() })).status, 200);
});

test('the WebSocket goes through with the launcher-held cookie, and not without a session', async (t) => {
  const { kc, mock, origin, host } = await setup(t);
  assert.match(await wsOpen(kc.port, host, origin), /403/, 'no session yet');
  await kc.signIn(mock.mintLink());
  const out = await wsOpen(kc.port, host, origin);
  assert.match(out, /^HTTP\/1\.1 101/);
  assert.match(out, /hello from the mock gateway/);
  assert.match(await wsOpen(kc.port, host, 'http://localhost:5476'), /403/, 'foreign Origin');
  assert.equal(mock.rec.dash.wsOpens, 1);
});

test('a restarted launcher keeps the origin, port and session; Disconnect signs out and rotates the origin', async (t) => {
  const first = await setup(t);
  await first.kc.signIn(first.mock.mintLink());
  const { origin, stateFile } = first;
  const port = first.kc.port;
  await first.kc.close();
  // Same state file, same gateway: a new launcher run.
  const lines = [];
  const kc2 = createKcProxy({ gatewayPort: Number(new URL(`http://x:${first.mock.server.address().port}`).port), stateFile, frameAncestors: () => [], log: (l) => lines.push(l) });
  await kc2.listen();
  t.after(() => kc2.close());
  assert.equal(kc2.port, port, 'the saved port');
  assert.equal(kc2.origin, origin, 'the saved label');
  assert.equal(kc2.status().connected, true);
  const host = new URL(origin).host;
  assert.equal((await req(kc2.port, { path: '/api/auth/me', headers: { host } })).status, 200, 'no new sign-in needed');
  const logouts = first.mock.rec.dash.logouts;
  await kc2.disconnect();
  assert.equal(first.mock.rec.dash.logouts, logouts + 1, 'POST /api/auth/logout reached the gateway');
  assert.equal(kc2.status().connected, false);
  assert.notEqual(kc2.origin, origin);
  assert.equal((await req(kc2.port, { headers: { host } })).status, 421, 'the old origin is dead');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.token, '');
  assert.equal(saved.refresh, '');
  assert.ok(!lines.some((l) => /token=|mc_token|mc_refresh/.test(l)), 'no credential in the log');
});
