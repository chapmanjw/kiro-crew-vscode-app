// The server update path, end to end: a real launcher, a stand-in update service on
// loopback, and small fake VS Code server builds. A working fake serves /version, so
// the launcher sees it start; a broken one exits at once. POSIX only (shell wrappers).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signProxyRequest } from '../backend/lib/auth.mjs';
import { serverPlatformSlug } from '../backend/lib/discovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(16).toString('hex');
const OLD = 'c1'.repeat(20);
const NEW = 'd2'.repeat(20);
const BAD = 'e3'.repeat(20);
const SLUG = serverPlatformSlug(process.platform, process.arch);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = process.platform === 'win32' ? 'the fake builds are POSIX shell scripts' : SLUG ? false : 'no server build for this platform';

const SERVER_MAIN = `const http = require('node:http');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
http.createServer((req, res) => {
  if (req.url.startsWith('/version')) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('fake'); }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1');
`;

/** A build folder (node, out/server-main.js, product.json) and its archive, laid out as the update service serves them. */
function makeBuild(stage, commit, version, mode) {
  const dir = path.join(stage, commit);
  const root = path.join(dir, `vscode-server-${SLUG}-web`);
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  fs.writeFileSync(path.join(root, 'product.json'), JSON.stringify({ version, commit, quality: 'stable' }));
  fs.writeFileSync(path.join(root, 'out', 'server-main.js'), SERVER_MAIN);
  const node = mode === 'broken' ? '#!/bin/sh\nexit 3\n' : `#!/bin/sh\nexec '${process.execPath}' "$@"\n`;
  fs.writeFileSync(path.join(root, 'node'), node, { mode: 0o755 });
  const archive = path.join(dir, `${commit}.tar.gz`);
  const r = spawnSync('tar', ['-czf', archive, '-C', dir, path.basename(root)]);
  assert.equal(r.status, 0, String(r.stderr));
  return { root, archive, sha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), version, commit };
}

/** The update service's answers for the builds in `state.builds`; `state.latest` is the commit the latest address names. */
function startStub(state) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://stub');
    const meta = (b) => ({ version: b.commit, name: b.version, productVersion: b.version, url: `${state.base}/dl/${b.commit}.tar.gz`, sha256hash: b.sha256 });
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (u.pathname === `/api/update/server-${SLUG}-web/stable/latest`) {
      return state.builds[state.latest] ? send(200, meta(state.builds[state.latest])) : send(404, 'no build', 'text/plain');
    }
    const byCommit = new RegExp(`^/api/versions/commit:([0-9a-f]{40})/server-${SLUG}-web/stable$`).exec(u.pathname);
    if (byCommit && state.builds[byCommit[1]]) return send(200, meta(state.builds[byCommit[1]]));
    const dl = /^\/dl\/([0-9a-f]{40})\.tar\.gz$/.exec(u.pathname);
    if (dl && state.builds[dl[1]]) {
      res.writeHead(200, { 'content-type': 'application/gzip' });
      return fs.createReadStream(state.builds[dl[1]].archive).pipe(res);
    }
    return send(404, 'not found', 'text/plain');
  });
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      state.base = `http://127.0.0.1:${server.address().port}`;
      ok(server);
    }),
  );
}

function startLauncher({ dataDir, port, base, serverDir = null }) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PORT: String(port),
    KIROCREW_PROXY_SECRET: SECRET,
    KIROCREW_APP_NAME: 'vscode-pane',
    KIROCREW_HOME: path.join(dataDir, '..', 'kiro-crew-home'),
    VSCODE_PANE_DATA_DIR: dataDir,
    VSCODE_PANE_WORKSPACE: path.join(dataDir, '..', 'workspace'),
    VSCODE_PANE_CODE_CLI: 'kiro-test-no-such-code-cli',
    VSCODE_PANE_DEV_CACHE: path.join(dataDir, '..', 'no-dev-cache'),
    VSCODE_PANE_UPDATE_BASE: base,
  };
  if (serverDir) env.VSCODE_PANE_SERVER_DIR = serverDir;
  return spawn(process.execPath, [path.join(ROOT, 'backend', 'launcher.mjs')], { env, stdio: 'ignore', windowsHide: true });
}

async function api(port, method, p, body) {
  const buf = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = signProxyRequest({ secret: SECRET, ts, method, target: p, body: buf });
  const headers = { 'x-kirocrew-proxy': sig };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body: body === undefined ? undefined : buf });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function waitFor(fn, ms = 60_000) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`timed out; last answer ${JSON.stringify(last)}`);
}

/** Resolves once the launcher answers its health check (it is not up the moment it is spawned). */
async function waitListening(port) {
  await waitFor(() => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false), 30_000);
}

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

test('an installed server build is checked for and updated from the page, and a build that will not start is rolled back', { skip, timeout: 300_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-upd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stage = path.join(dir, 'stage');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(dataDir, 'server'), { recursive: true });
  const builds = {
    [OLD]: makeBuild(stage, OLD, '1.100.0', 'works'),
    [NEW]: makeBuild(stage, NEW, '1.200.0', 'works'),
    [BAD]: makeBuild(stage, BAD, '1.300.0', 'broken'),
  };
  // The copy the app already has: the OLD build, in its own data folder.
  fs.cpSync(builds[OLD].root, path.join(dataDir, 'server', OLD), { recursive: true });
  const state = { builds, latest: NEW, base: '' };
  const stub = await startStub(state);
  t.after(() => stub.close());

  const port = await freePort();
  const child = startLauncher({ dataDir, port, base: state.base });
  t.after(() => child.kill());
  await waitListening(port);
  const ready = (pred) =>
    waitFor(async () => {
      const s = await api(port, 'GET', '/api/session').then((r) => r.json, () => null);
      return s && s.ready && pred(s) ? s : null;
    }, 120_000);

  const first = await ready((s) => s.server && s.server.commit === OLD);
  assert.equal(first.server.owned, true, 'a build in the data folder the app installed is the app\'s to update');
  assert.equal(first.server.name, '1.100.0');
  assert.equal(first.update, null);

  // Check: the newest stable build is NEW.
  const c1 = await api(port, 'POST', '/api/server-update/check', {});
  assert.equal(c1.status, 200);
  assert.equal(c1.json.phase, 'available');
  assert.equal(c1.json.latest.commit, NEW);
  assert.equal(c1.json.latest.name, '1.200.0');

  // An update installs only the build the last check named.
  assert.equal((await api(port, 'POST', '/api/server-update/install', { commit: BAD })).status, 409);
  assert.equal((await api(port, 'POST', '/api/server-update/install', { commit: 'not a commit' })).status, 400);

  // Update: NEW is downloaded, checked and started, and OLD is removed once NEW runs.
  assert.equal((await api(port, 'POST', '/api/server-update/install', { commit: NEW })).status, 202);
  const updated = await ready((s) => s.server.commit === NEW && s.update && s.update.phase === 'done');
  assert.equal(updated.server.name, '1.200.0');
  assert.equal(fs.existsSync(path.join(dataDir, 'server', OLD)), false, 'the build it replaced is removed');
  const rec = JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'server-build.json'), 'utf8'));
  assert.equal(rec.commit, NEW);
  assert.equal(rec.via, 'update');
  assert.equal(rec.previous, null);
  assert.equal((await api(port, 'POST', '/api/server-update/check', {})).json.phase, 'current');

  // A newer build that does not start: it is removed, and the build that ran comes back.
  state.latest = BAD;
  assert.equal((await api(port, 'POST', '/api/server-update/check', {})).json.latest.commit, BAD);
  assert.equal((await api(port, 'POST', '/api/server-update/install', { commit: BAD })).status, 202);
  const back = await ready((s) => s.server.commit === NEW && s.update && s.update.phase === 'failed');
  assert.match(back.update.error, /did not start/);
  assert.equal(fs.existsSync(path.join(dataDir, 'server', BAD)), false, 'the build that did not start is removed');
  const rec2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'server-build.json'), 'utf8'));
  assert.equal(rec2.commit, NEW);
  assert.equal(rec2.via, 'rollback');

  // A build the user pointed at (serverDir) is not the app's: no check, no update.
  child.kill();
  await sleep(500);
  const port2 = await freePort();
  const child2 = startLauncher({ dataDir, port: port2, base: state.base, serverDir: builds[NEW].root });
  t.after(() => child2.kill());
  await waitListening(port2);
  const own = await waitFor(async () => {
    const s = await api(port2, 'GET', '/api/session').then((r) => r.json, () => null);
    return s && s.ready ? s : null;
  }, 120_000);
  assert.equal(own.server.owned, false);
  assert.equal((await api(port2, 'POST', '/api/server-update/check', {})).status, 409);
});
