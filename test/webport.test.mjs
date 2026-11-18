// The remote crew port check: the gateway relays the app's web origin only on
// its own dashboard ports, so the launcher asks it what the browser will ask,
// says why it refuses, and can add the one port that fixes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validPort, listedPorts, withAllowedPort, addAllowedPort, diagnose, PORTS_VAR } from '../backend/lib/weborigin.mjs';
import { matchRoute } from '../backend/lib/router.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreFile = fs.readdirSync(path.join(ROOT, 'ui')).find((f) => /^vscode-pane-core-.*\.mjs$/.test(f));
const { webOriginAdvice } = await import(pathToFileURL(path.join(ROOT, 'ui', coreFile)).href);

test('validPort accepts a plain TCP port only', () => {
  assert.equal(validPort('7778'), 7778);
  assert.equal(validPort(7778), 7778);
  assert.equal(validPort(' 80 '), 80);
  for (const bad of ['', '0', '65536', '-1', '77a', '7778,7779', '1e3', null, undefined, {}, '0x10']) assert.equal(validPort(bad), 0, String(bad));
});

test('listedPorts reads the last KIROCREW_ALLOWED_LOOPBACK_PORTS line, quoted or exported, ignoring junk entries', () => {
  assert.deepEqual(listedPorts(''), []);
  assert.deepEqual(listedPorts('A=1\nKIROCREW_ALLOWED_LOOPBACK_PORTS=7778\n'), [7778]);
  assert.deepEqual(listedPorts('export KIROCREW_ALLOWED_LOOPBACK_PORTS="7778, 7779,x,0,7778"'), [7778, 7779]);
  assert.deepEqual(listedPorts('KIROCREW_ALLOWED_LOOPBACK_PORTS=1\nKIROCREW_ALLOWED_LOOPBACK_PORTS=2'), [2]);
  assert.deepEqual(listedPorts('# KIROCREW_ALLOWED_LOOPBACK_PORTS=9\nOTHER_KIROCREW_ALLOWED_LOOPBACK_PORTS=8'), []);
});

test('withAllowedPort adds the port to the line, keeps every other line, and is idempotent', () => {
  const a = withAllowedPort('', 7778);
  assert.deepEqual(a, { text: 'KIROCREW_ALLOWED_LOOPBACK_PORTS=7778\n', changed: true, ports: [7778] });
  const b = withAllowedPort('KEY=1\nKIROCREW_ALLOWED_LOOPBACK_PORTS=7778\nOTHER=2\n', 7779);
  assert.equal(b.text, 'KEY=1\nKIROCREW_ALLOWED_LOOPBACK_PORTS=7778,7779\nOTHER=2\n');
  assert.equal(b.changed, true);
  const c = withAllowedPort(b.text, 7779);
  assert.equal(c.changed, false);
  assert.equal(c.text, b.text);
  const d = withAllowedPort('KEY=1', 7778);
  assert.equal(d.text, 'KEY=1\nKIROCREW_ALLOWED_LOOPBACK_PORTS=7778\n');
  const e = withAllowedPort('KIROCREW_ALLOWED_LOOPBACK_PORTS=1\nX=1\nKIROCREW_ALLOWED_LOOPBACK_PORTS=2\n', 3);
  assert.equal(e.text, 'X=1\nKIROCREW_ALLOWED_LOOPBACK_PORTS=2,3\n', 'a repeated assignment collapses into the last one');
  assert.throws(() => withAllowedPort('', 'abc'), /not a TCP port/);
});

test('addAllowedPort writes <home>/.env owner-only and never touches the other lines', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-env-'));
  try {
    fs.writeFileSync(path.join(home, '.env'), 'SECRET_KEY=abc\n', { mode: 0o600 });
    const r = addAllowedPort({ home, port: 7778 });
    assert.equal(r.ok, true);
    assert.equal(r.changed, true);
    assert.equal(fs.readFileSync(path.join(home, '.env'), 'utf8'), `SECRET_KEY=abc\n${PORTS_VAR}=7778\n`);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, '.env')).mode & 0o777, 0o600);
    const again = addAllowedPort({ home, port: 7778 });
    assert.deepEqual([again.ok, again.changed, again.ports], [true, false, [7778]]);
    assert.equal(addAllowedPort({ home, port: 'x' }).ok, false);
    assert.equal(addAllowedPort({ home: '', port: 7778 }).ok, false);
    // A new file is created owner-only when there is none.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-env2-'));
    assert.equal(addAllowedPort({ home: fresh, port: 7779 }).ok, true);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(fresh, '.env')).mode & 0o777, 0o600);
    fs.rmSync(fresh, { recursive: true, force: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('diagnose tells ok, a port the gateway does not allow, a disabled app and a dead gateway apart', async () => {
  const base = { appName: 'vscode-pane', probePath: '/vsc-k/_vscp-probe', instance: 'RUN1' };
  let allowedNow = [];
  // A stand-in relay: answers this run's id on the ports in allowedNow, 421 on the rest.
  const live = await new Promise((ok) => {
    const s = http.createServer((req, res) => {
      const m = /:(\d+)$/.exec(String(req.headers.host || ''));
      const port = m ? Number(m[1]) : 0;
      if (!allowedNow.includes(port)) {
        res.writeHead(421);
        return res.end('misdirected request');
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('RUN1');
    });
    s.listen(0, '127.0.0.1', () => ok({ s, port: s.address().port }));
  });
  try {
    allowedNow = [live.port];
    assert.deepEqual(await diagnose({ ...base, gatewayPort: live.port, port: live.port }), { state: 'ok', port: live.port });
    assert.deepEqual(await diagnose({ ...base, gatewayPort: live.port, port: 7778 }), { state: 'port_not_allowed', port: 7778 });
    allowedNow = [live.port, 7778];
    assert.equal((await diagnose({ ...base, gatewayPort: live.port, port: 7778 })).state, 'ok');
    allowedNow = [];
    const none = await diagnose({ ...base, gatewayPort: live.port, port: 7778 });
    assert.equal(none.state, 'refused', 'refused on its own port too: another reason than the port');
    allowedNow = [7778];
    assert.equal((await diagnose({ ...base, gatewayPort: live.port, port: live.port })).state, 'refused');
    assert.equal((await diagnose({ ...base, gatewayPort: live.port, port: 7778 })).state, 'ok');
    // The answer must be this run's id, not just any 200.
    assert.equal((await diagnose({ ...base, gatewayPort: live.port, port: 7778, instance: 'OTHER' })).state, 'unexpected');
  } finally {
    live.s.close();
  }
  // Nothing listening: the gateway is unreachable.
  const dead = await new Promise((ok) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });
  assert.equal((await diagnose({ ...base, gatewayPort: dead, port: 7778 })).state, 'gateway_unreachable');
  // A gateway that answers 404 has no web origin for the app.
  const noApp = await new Promise((ok) => {
    const s = http.createServer((req, res) => {
      res.writeHead(404);
      res.end('not found');
    });
    s.listen(0, '127.0.0.1', () => ok({ s, port: s.address().port }));
  });
  try {
    assert.equal((await diagnose({ ...base, gatewayPort: noApp.port, port: 7778 })).state, 'not_enabled');
  } finally {
    noApp.s.close();
  }
});

test('the check and allow routes are signed, with the right methods', () => {
  assert.deepEqual(matchRoute('GET', '/api/web-origin', null), { name: 'webOrigin', auth: 'proxy' });
  assert.deepEqual(matchRoute('POST', '/api/web-origin/allow-port', null), { name: 'webOriginAllow', auth: 'proxy' });
  assert.deepEqual(matchRoute('POST', '/api/web-origin', null), { error: 405 });
  assert.deepEqual(matchRoute('GET', '/api/web-origin/allow-port', null), { error: 405 });
});

test('webOriginAdvice: the allow button only when the port is not yet listed, restart when it is', () => {
  assert.equal(webOriginAdvice({ state: 'ok' }, '7778'), null);
  assert.equal(webOriginAdvice(null, '7778'), null);
  const fresh = webOriginAdvice({ state: 'port_not_allowed', port: '7778', listed: [], envFile: '/h/.env', variable: PORTS_VAR }, '7778');
  assert.equal(fresh.allow, true);
  assert.equal(fresh.restart, false);
  assert.match(fresh.message, /port 7778/);
  assert.match(fresh.message, /\/h\/\.env/);
  const listed = webOriginAdvice({ state: 'port_not_allowed', port: '7778', listed: [7778], envFile: '/h/.env' }, '7778');
  assert.equal(listed.allow, false);
  assert.equal(listed.restart, true);
  assert.match(listed.message, /kirocrew restart/);
  for (const state of ['not_enabled', 'refused', 'gateway_unreachable', 'unexpected', 'error']) {
    const a = webOriginAdvice({ state, port: '7778', detail: 'x' }, '7778');
    assert.equal(a.allow, false, state);
    assert.equal(a.again, true, state);
    assert.ok(a.title && a.message, state);
  }
});

// ---------------------------------------------------------------- the launcher's routes, end to end

test('GET /api/web-origin and POST /api/web-origin/allow-port, against a launcher and a stand-in relay', async (t) => {
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const crypto = await import('node:crypto');
  const { signProxyRequest } = await import('../backend/lib/auth.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-wp-'));
  const secret = crypto.randomBytes(16).toString('hex');
  const free = () => new Promise((ok) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });
  const launcherPort = await free();
  // The stand-in gateway: relays `<app>.apps.localhost:<port>` to the launcher on the allowed ports, 421 on the rest.
  const allowed = new Set();
  const relay = http.createServer((req, res) => {
    const m = /^vscode-pane\.apps\.localhost:(\d+)$/.exec(String(req.headers.host || ''));
    if (!m) {
      res.writeHead(404);
      return res.end('not found');
    }
    if (!allowed.has(Number(m[1]))) {
      res.writeHead(421);
      return res.end('misdirected request');
    }
    const up = http.request({ host: '127.0.0.1', port: launcherPort, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  await new Promise((ok) => relay.listen(0, '127.0.0.1', ok));
  const gw = relay.address().port;
  allowed.add(gw);
  const home = path.join(dir, 'kc-home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.env'), 'KEEP_ME=1\n', { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(ROOT, 'backend', 'launcher.mjs')], {
    env: {
      ...process.env,
      PORT: String(launcherPort),
      KIROCREW_PROXY_SECRET: secret,
      KIROCREW_APP_NAME: 'vscode-pane',
      KIROCREW_GATEWAY_ORIGIN: `http://127.0.0.1:${gw}`,
      KIROCREW_HOME: home,
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
    relay.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = async (method, p, body) => {
    const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signProxyRequest({ secret, ts, method, target: p, body: buf });
    const r = await fetch(`http://127.0.0.1:${launcherPort}${p}`, { method, headers: { 'x-kirocrew-proxy': sig, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : buf });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${launcherPort}/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // The dashboard's port, as a Remote Crew's tunnel gives it, is not one the gateway counts.
  let r = await call('GET', '/api/web-origin?port=7778');
  assert.equal(r.status, 200);
  assert.equal(r.json.state, 'port_not_allowed');
  assert.deepEqual(r.json.listed, []);
  assert.equal(r.json.envFile, path.join(home, '.env'));
  assert.equal(r.json.variable, PORTS_VAR);
  // Its own port is fine.
  r = await call('GET', `/api/web-origin?port=${gw}`);
  assert.equal(r.json.state, 'ok');
  assert.equal((await call('GET', '/api/web-origin?port=abc')).status, 400);

  // The button: one line added, every other line kept, owner-only, a restart asked for.
  const bad = await call('POST', '/api/web-origin/allow-port', { port: 'x' });
  assert.equal(bad.status, 400);
  const add = await call('POST', '/api/web-origin/allow-port', { port: 7778 });
  assert.equal(add.status, 200);
  assert.deepEqual([add.json.ok, add.json.changed, add.json.restartNeeded], [true, true, true]);
  assert.equal(fs.readFileSync(path.join(home, '.env'), 'utf8'), `KEEP_ME=1\n${PORTS_VAR}=7778\n`);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(home, '.env')).mode & 0o777, 0o600);

  // Until the gateway restarts it still refuses, and the answer now says the port is listed.
  r = await call('GET', '/api/web-origin?port=7778');
  assert.equal(r.json.state, 'port_not_allowed');
  assert.deepEqual(r.json.listed, [7778]);
  assert.equal(webOriginAdvice(r.json, '7778').restart, true);

  // After the restart (here: the stand-in now counts the port) the check passes.
  allowed.add(7778);
  r = await call('GET', '/api/web-origin?port=7778');
  assert.equal(r.json.state, 'ok');
});
