// Tests for the V1-review fixes: user environment, stable restarts, bounded
// retries, command TTL, Host/Origin checks, https-only and checksummed download.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { expandVars, mergeWindowsEnv, sessionVars, windowsUserEnv } from '../backend/lib/userenv.mjs';
import { buildServerEnv, terminalEnvSettings, TERMINAL_UNSET } from '../backend/lib/args.mjs';
import { Bridge } from '../backend/lib/bridge.mjs';
import { RetryPolicy } from '../backend/lib/retry.mjs';
import { isLoopbackHost, upgradeAllowed } from '../backend/lib/frameproxy.mjs';
import { urlAllowed, downloadFile, fetchJson } from '../backend/lib/provision.mjs';
import { serverMetadataUrl } from '../backend/lib/discovery.mjs';

const COMMIT = '69047191fc427f2f92828279aae1d90d8eeda7ab';

// ---------------------------------------------------------------- (1) user environment
test('expandVars replaces known %VARS% and leaves unknown ones', () => {
  const look = (n) => ({ USERPROFILE: 'C:\\Users\\me', X: '1' })[n.toUpperCase()];
  assert.equal(expandVars('%USERPROFILE%\\go', look), 'C:\\Users\\me\\go');
  assert.equal(expandVars('%nope%;%X%', look), '%nope%;1');
  assert.equal(expandVars('100%', look), '100%');
});

test('mergeWindowsEnv: session < machine < user, Path appended, case-insensitive, expanded', () => {
  const env = mergeWindowsEnv({
    session: { USERPROFILE: 'C:\\Users\\me', USERNAME: 'me', SystemRoot: 'C:\\Windows' },
    machine: { Path: '%SystemRoot%\\system32;C:\\Tools', PSModulePath: '%ProgramFiles%\\WindowsPowerShell\\Modules', ProgramFiles: 'C:\\Program Files', TEMP: '%SystemRoot%\\TEMP' },
    user: { PATH: '%USERPROFILE%\\bin', TEMP: '%USERPROFILE%\\AppData\\Local\\Temp', GOPATH: '%USERPROFILE%\\go' },
  });
  const keys = Object.keys(env).map((k) => k.toUpperCase());
  assert.equal(new Set(keys).size, keys.length, 'no duplicate names differing only in case');
  const get = (n) => env[Object.keys(env).find((k) => k.toUpperCase() === n)];
  assert.equal(get('PATH'), 'C:\\Windows\\system32;C:\\Tools;C:\\Users\\me\\bin');
  assert.equal(get('TEMP'), 'C:\\Users\\me\\AppData\\Local\\Temp', 'user value wins');
  assert.equal(get('GOPATH'), 'C:\\Users\\me\\go');
  assert.equal(get('PSMODULEPATH'), 'C:\\Program Files\\WindowsPowerShell\\Modules');
});

test('sessionVars fills logon-only variables from a stripped env', () => {
  const v = sessionVars({ SystemRoot: 'C:\\Windows' }, { homedir: 'C:\\Users\\me', username: 'me', hostname: 'box', cpus: 8 });
  assert.equal(v.USERNAME, 'me');
  assert.equal(v.USERPROFILE, 'C:\\Users\\me');
  assert.equal(v.HOMEDRIVE, 'C:');
  assert.equal(v.HOMEPATH, '\\Users\\me');
  assert.equal(v.APPDATA, 'C:\\Users\\me\\AppData\\Roaming');
  assert.equal(v.LOCALAPPDATA, 'C:\\Users\\me\\AppData\\Local');
  assert.equal(v['ProgramFiles(x86)'], 'C:\\Program Files (x86)');
  assert.equal(v.COMPUTERNAME, 'BOX');
  assert.equal(v.NUMBER_OF_PROCESSORS, '8');
});

test('windowsUserEnv reads the real registry under a stripped env', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const stripped = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
  const env = windowsUserEnv(stripped);
  assert.ok(env, 'registry read succeeded');
  const get = (n) => env[Object.keys(env).find((k) => k.toUpperCase() === n)];
  assert.ok(get('PSMODULEPATH'), 'PSModulePath from HKLM');
  assert.ok(get('USERNAME'), 'USERNAME from the session');
  assert.ok(get('PROGRAMFILES(X86)'));
  assert.ok(!/%[A-Za-z_]+%/.test(get('PATH')), 'Path has no unexpanded %VAR%');
  assert.ok(!/%[A-Za-z_]+%/.test(get('TEMP') || ''), 'TEMP expanded');
});

test('buildServerEnv with userEnv: user vars, tracking vars kept, gateway env and secrets dropped', () => {
  const env = buildServerEnv(
    { PATH: 'gateway-path', KIROCREW_PROXY_SECRET: 's', KIROCREW_SPAWNED: '1', kirocrew_spawn_instance: 'abc', KIROCREW_APP_NAME: 'vscode-pane' },
    { bridgeUrl: 'http://127.0.0.1:9', bridgeSecret: 'b', userEnv: { Path: 'user-path', GOPATH: 'C:\\go', VSCODE_IPC_HOOK: 'x', PORT: '5' } },
  );
  assert.equal(env.Path, 'user-path');
  assert.equal(env.PATH, undefined, 'gateway PATH not carried over');
  assert.equal(env.GOPATH, 'C:\\go');
  assert.equal(env.KIROCREW_SPAWNED, '1');
  assert.equal(env.KIROCREW_SPAWN_INSTANCE, 'abc');
  assert.equal(env.KIROCREW_PROXY_SECRET, undefined);
  assert.equal(env.KIROCREW_APP_NAME, undefined);
  assert.equal(env.VSCODE_IPC_HOOK, undefined);
  assert.equal(env.PORT, undefined);
  assert.equal(env.KIROCREW_VSCODE_BRIDGE_SECRET, 'b');
});

test('terminalEnvSettings unsets tracking and bridge vars for terminals and keeps other settings', () => {
  const out = JSON.parse(terminalEnvSettings('{"editor.fontSize": 15, "terminal.integrated.env.windows": {"FOO": "bar"}}'));
  assert.equal(out['editor.fontSize'], 15);
  assert.equal(out['terminal.integrated.env.windows'].FOO, 'bar');
  for (const os of ['windows', 'linux', 'osx']) {
    for (const n of TERMINAL_UNSET) assert.equal(out[`terminal.integrated.env.${os}`][n], null);
  }
  assert.ok(TERMINAL_UNSET.includes('KIROCREW_SPAWNED'));
  assert.ok(TERMINAL_UNSET.includes('KIROCREW_VSCODE_BRIDGE_SECRET'));
  assert.ok(JSON.parse(terminalEnvSettings('')));
  assert.equal(terminalEnvSettings('// comment\n{}'), null, 'JSONC is left alone');
  assert.equal(terminalEnvSettings('[]'), null);
});

// ---------------------------------------------------------------- (4) bounded retries
test('RetryPolicy: provisioning errors never auto-retry', () => {
  const r = new RetryPolicy();
  assert.equal(r.recordStartFailure('provision').retry, false);
});

test('RetryPolicy: start failures stop after the cap within the window, reset restores', () => {
  let t = 0;
  const r = new RetryPolicy({ maxStartFailures: 3, startWindowMs: 1000, now: () => t });
  assert.deepEqual(r.recordStartFailure(), { retry: true, delayMs: 1000 });
  assert.deepEqual(r.recordStartFailure(), { retry: true, delayMs: 2000 });
  assert.equal(r.recordStartFailure().retry, false);
  r.reset();
  assert.equal(r.recordStartFailure().retry, true);
  t = 5000; // old failures fall out of the window
  r.recordStartFailure();
  t = 10_000;
  assert.equal(r.recordStartFailure().retry, true);
  r.recordSuccess();
  assert.equal(r.startFailures.length, 0);
});

test('RetryPolicy: crashes stop after the cap within the window', () => {
  let t = 0;
  const r = new RetryPolicy({ maxCrashes: 2, crashWindowMs: 1000, now: () => t });
  assert.equal(r.recordCrash().retry, true);
  assert.equal(r.recordCrash().retry, false);
  t = 5000;
  assert.equal(r.recordCrash().retry, true, 'crashes outside the window do not count');
  assert.equal(RetryPolicy.backoff(10), 30_000);
});

// ---------------------------------------------------------------- (5) command TTL
test('Bridge drops queued commands after their TTL', async () => {
  let t = 0;
  const b = new Bridge({ now: () => t, commandTtlMs: 60_000 });
  b.enqueue({ kind: 'openFile', path: '/old' }, 10);
  t = 30_000;
  b.enqueue({ kind: 'openFile', path: '/new' }, 10);
  t = 61_000; // /old expired, /new still fresh
  assert.equal(b.snapshot().pendingCommands, 1);
  assert.deepEqual((await b.take(0)).map((c) => c.path), ['/new']);
  assert.equal(b.expiry.size, 0, 'no expiry entries leak');
});

test('Bridge.resetConnection forgets the extension after a server restart', () => {
  const b = new Bridge();
  b.applyEvent({ type: 'hello', version: '1' });
  b.applyEvent({ type: 'editor', path: '/a' });
  assert.equal(b.connected, true);
  b.resetConnection();
  assert.equal(b.connected, false);
  assert.equal(b.extension, null);
  assert.equal(b.editor, null);
});

// ---------------------------------------------------------------- (3) Host / Origin
test('isLoopbackHost and upgradeAllowed', () => {
  assert.equal(isLoopbackHost('127.0.0.1:5'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('evil.example:5'), false);
  assert.equal(isLoopbackHost(undefined), false);
  assert.equal(upgradeAllowed({ host: '127.0.0.1:5', origin: undefined, listenPort: 5 }), true);
  assert.equal(upgradeAllowed({ host: '127.0.0.1:5', origin: 'http://127.0.0.1:5', listenPort: 5 }), true, 'the frame itself');
  assert.equal(upgradeAllowed({ host: '127.0.0.1:5', origin: 'http://localhost:5476', listenPort: 5 }), false, 'the dashboard page is not the frame');
  assert.equal(upgradeAllowed({ host: '127.0.0.1:5', origin: 'https://evil.example', listenPort: 5 }), false);
  assert.equal(upgradeAllowed({ host: 'rebound.example:5', origin: 'http://rebound.example:5', listenPort: 5 }), false);
});

// ---------------------------------------------------------------- (6) download
test('urlAllowed is https-only unless allowHttp', () => {
  assert.equal(urlAllowed('https://update.code.visualstudio.com/x'), true);
  assert.equal(urlAllowed('http://update.code.visualstudio.com/x'), false);
  assert.equal(urlAllowed('http://127.0.0.1/x', { allowHttp: true }), true);
  assert.equal(urlAllowed('ftp://x/y', { allowHttp: true }), false);
  assert.equal(urlAllowed('not a url'), false);
  assert.equal(serverMetadataUrl(COMMIT, 'win32', 'x64'), `https://update.code.visualstudio.com/api/versions/commit:${COMMIT}/server-win32-x64-web/stable`);
});

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('download refuses a non-https URL and a redirect to plain http', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-dl-'));
  try {
    await assert.rejects(downloadFile('http://127.0.0.1:1/x', path.join(tmp, 'a')), /refusing non-https/);
    const srv = await serve((req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:1/plain' });
      res.end();
    });
    // allowHttp only for the first hop would still be refused for the redirect when not allowed:
    await assert.rejects(fetchJson(`http://127.0.0.1:${srv.address().port}/meta`), /refusing non-https/);
    srv.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('download verifies the SHA-256 and deletes a mismatching file', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-sha-'));
  const body = Buffer.from('server archive bytes');
  const good = crypto.createHash('sha256').update(body).digest('hex');
  const srv = await serve((req, res) => {
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
  });
  try {
    const url = `http://127.0.0.1:${srv.address().port}/f`;
    const ok = await downloadFile(url, path.join(tmp, 'ok'), { allowHttp: true, expectedSha256: good });
    assert.equal(ok.sha256, good);
    const bad = path.join(tmp, 'bad');
    await assert.rejects(downloadFile(url, bad, { allowHttp: true, expectedSha256: '0'.repeat(64) }), /checksum mismatch/);
    assert.equal(fs.existsSync(bad), false);
  } finally {
    srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('launcher stops auto-retrying a permanent failure and reports it in /api/session', { timeout: 30_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-retry-'));
  const port = await new Promise((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'backend', 'launcher.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      VSCODE_PANE_DATA_DIR: tmp,
      VSCODE_PANE_SERVER_DIR: path.join(tmp, 'no-such-build'),
      VSCODE_PANE_DEV_CACHE: path.join(tmp, 'no-cache'),
      VSCODE_PANE_NO_DOWNLOAD: '1',
      VSCODE_PANE_ALLOW_UNSIGNED: '1',
      VSCODE_PANE_CODE_CLI: path.join(tmp, 'no-code-cli'),
      KIROCREW_PROXY_SECRET: '',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const getJson = (p) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: p }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
  try {
    let s;
    for (let i = 0; i < 60; i++) {
      s = await getJson('/api/session').catch(() => null);
      if (s && s.status === 'error') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(s.status, 'error');
    assert.equal(s.autoRetry, false);
    assert.match(s.message, /^Stopped:/);
    assert.match(s.error, /Restart server/);
    // No further attempts happen on their own.
    const before = fs.readFileSync(path.join(tmp, 'logs', 'launcher.log'), 'utf8').split('Locating VS Code server').length;
    await new Promise((r) => setTimeout(r, 2500));
    const after = fs.readFileSync(path.join(tmp, 'logs', 'launcher.log'), 'utf8').split('Locating VS Code server').length;
    assert.equal(after, before, 'no automatic retry');
  } finally {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
