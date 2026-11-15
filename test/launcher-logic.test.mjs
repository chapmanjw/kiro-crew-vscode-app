import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

import { resolveDataDir, parseConfig, effectiveConfig } from '../backend/lib/config.mjs';
import { parseCodeVersion, isServerBuild, findServerBuild, serverDownloadUrl, serverPlatformSlug } from '../backend/lib/discovery.mjs';
import { buildServerArgs, buildServerEnv, toFolderParam, workbenchUrl } from '../backend/lib/args.mjs';
import { verifyProxySignature, signProxyRequest, checkBridgeSecret, randomSecret } from '../backend/lib/auth.mjs';
import { matchRoute, parseOpenRequest, fileMenuToCommand, ROUTES } from '../backend/lib/router.mjs';
import { Bridge } from '../backend/lib/bridge.mjs';
import { upsertBridgeEntry, staleBridgeFolders, fileUriComponents, BRIDGE_ID, bridgeFolderName } from '../backend/lib/extensions.mjs';
import { upstreamHeaderPairs, filterSetCookie } from '../backend/lib/frameproxy.mjs';
import { downloadFile, extractArchive, locateBuildRoot, tarCommand } from '../backend/lib/provision.mjs';

const COMMIT = '69047191fc427f2f92828279aae1d90d8eeda7ab';

// ---------------------------------------------------------------- config
test('resolveDataDir prefers explicit env, else <appRoot>/data', () => {
  assert.equal(resolveDataDir({}, path.resolve('/app')), path.join(path.resolve('/app'), 'data'));
  assert.equal(resolveDataDir({ KIROCREW_APP_DATA_DIR: '/x/d' }, '/app'), path.resolve('/x/d'));
  assert.equal(resolveDataDir({ VSCODE_PANE_DATA_DIR: '/t', KIROCREW_APP_DATA_DIR: '/x' }, '/app'), path.resolve('/t'));
  assert.equal(resolveDataDir({ VSCODE_PANE_DATA_DIR: '   ' }, path.resolve('/app')), path.join(path.resolve('/app'), 'data'));
});

test('parseConfig tolerates missing and malformed files', () => {
  assert.deepEqual(parseConfig(''), {});
  assert.deepEqual(parseConfig('{bad'), {});
  assert.deepEqual(parseConfig('[1]'), {});
  assert.deepEqual(parseConfig('{"workspace":"C:\\\\w"}'), { workspace: 'C:\\w' });
});

test('effectiveConfig: env beats file, workspace defaults to home', () => {
  const c = effectiveConfig({ workspace: '/from-file', serverDir: '/srv' }, { VSCODE_PANE_WORKSPACE: '/from-env' }, { homedir: '/home/u', appRoot: '/app' });
  assert.equal(c.workspace, '/from-env');
  assert.equal(c.serverDir, '/srv');
  assert.equal(c.codeCli, 'code');
  assert.equal(c.allowDownload, true);
  const d = effectiveConfig({}, { VSCODE_PANE_NO_DOWNLOAD: '1' }, { homedir: '/home/u', appRoot: '/app' });
  assert.equal(d.workspace, '/home/u');
  assert.equal(d.serverDir, null);
  assert.equal(d.allowDownload, false);
  assert.match(d.devCacheRoot, /serve-web[\\/]cli-data[\\/]serve-web$/);
});

// ---------------------------------------------------------------- discovery
test('parseCodeVersion reads version and commit', () => {
  assert.deepEqual(parseCodeVersion(`1.146.0\r\n${COMMIT}\r\nx64\r\n`), { version: '1.146.0', commit: COMMIT });
  assert.deepEqual(parseCodeVersion('garbage'), { version: null, commit: null });
  assert.deepEqual(parseCodeVersion(''), { version: null, commit: null });
});

function fakeFs(files) {
  const set = new Set(files.map((f) => path.normalize(f)));
  const exists = (p) => set.has(path.normalize(p));
  const listDirs = (root) => {
    const r = path.normalize(root) + path.sep;
    const names = new Set();
    for (const f of set) if (f.startsWith(r)) names.add(f.slice(r.length).split(path.sep)[0]);
    if (!names.size) throw new Error('ENOENT');
    return [...names];
  };
  return { exists, listDirs };
}
const build = (dir, platform = 'win32') => [path.join(dir, platform === 'win32' ? 'node.exe' : 'node'), path.join(dir, 'out', 'server-main.js')];

test('isServerBuild needs node and out/server-main.js', () => {
  const { exists } = fakeFs(build('/b'));
  assert.equal(isServerBuild('/b', exists, 'win32'), true);
  assert.equal(isServerBuild('/b', exists, 'linux'), false);
  assert.equal(isServerBuild('/c', exists, 'win32'), false);
  assert.equal(isServerBuild(null, exists, 'win32'), false);
});

test('findServerBuild order: configured, data/<commit>, dev-cache/<commit>, then any', () => {
  const OTHER = 'a'.repeat(40);
  const files = [...build('/cfg'), ...build(`/data/server/${COMMIT}`), ...build(`/dev/${COMMIT}`), ...build(`/dev/${OTHER}`)];
  const f = fakeFs(files);
  const base = { dataDir: '/data', devCacheRoot: '/dev', commit: COMMIT, ...f, platform: 'win32' };
  assert.equal(findServerBuild({ ...base, configured: '/cfg' }).source, 'configured');
  assert.equal(findServerBuild({ ...base, configured: '/missing' }).source, 'data');
  const noData = fakeFs([...build(`/dev/${COMMIT}`), ...build(`/dev/${OTHER}`)]);
  const r = findServerBuild({ ...base, ...noData, configured: null });
  assert.deepEqual([r.source, r.commit], ['dev-cache', COMMIT]);
  const other = findServerBuild({ ...base, ...noData, configured: null, commit: 'b'.repeat(40) });
  assert.equal(other.commit, OTHER, 'falls back to any build when the exact commit is absent');
  assert.equal(findServerBuild({ ...base, ...fakeFs([]), configured: null }), null);
});

test('serverDownloadUrl builds the update-service URL', () => {
  assert.equal(serverDownloadUrl(COMMIT, 'win32', 'x64'), `https://update.code.visualstudio.com/commit:${COMMIT}/server-win32-x64-web/stable`);
  assert.equal(serverPlatformSlug('darwin', 'arm64'), 'darwin-arm64');
  assert.throws(() => serverDownloadUrl('nope', 'win32', 'x64'), /invalid commit/);
  assert.throws(() => serverDownloadUrl(COMMIT, 'aix', 'ppc'), /no VS Code server build/);
});

// ---------------------------------------------------------------- args/env
test('buildServerArgs has loopback host, token file, dirs and no serve-web', () => {
  const a = buildServerArgs({ port: 4321, tokenFile: 'T', dataDir: 'D', workspace: 'W', basePath: '/vsc-k' });
  assert.equal(a[0], path.join('out', 'server-main.js'));
  const flag = (n) => a[a.indexOf(n) + 1];
  assert.equal(flag('--host'), '127.0.0.1');
  assert.equal(flag('--port'), '4321');
  assert.equal(flag('--connection-token-file'), 'T');
  assert.equal(flag('--server-data-dir'), path.join('D', 'server-data'));
  assert.equal(flag('--extensions-dir'), path.join('D', 'extensions'));
  assert.equal(flag('--default-folder'), 'W');
  assert.equal(flag('--server-base-path'), '/vsc-k');
  assert.ok(a.includes('--accept-server-license-terms'));
  assert.ok(!a.includes('--without-connection-token'));
  assert.ok(!a.includes('serve-web'));
  assert.ok(!a.includes('--default-folder') || a.includes('W'));
  assert.throws(() => buildServerArgs({ port: 0, tokenFile: 'T', dataDir: 'D' }), /invalid port/);
  assert.throws(() => buildServerArgs({ port: 1, dataDir: 'D' }), /tokenFile/);
  assert.ok(!buildServerArgs({ port: 1, tokenFile: 'T', dataDir: 'D' }).includes('--default-folder'));
});

test('buildServerEnv strips secrets and host VS Code vars, adds bridge vars', () => {
  const e = buildServerEnv(
    { PATH: 'p', KIROCREW_PROXY_SECRET: 's', kirocrew_gateway_origin_proof: 'x', PORT: '1', VSCODE_IPC_HOOK_CLI: 'pipe', KIROCREW_SPAWNED: '1', KIROCREW_SPAWN_INSTANCE: 'i' },
    { bridgeUrl: 'http://127.0.0.1:9', bridgeSecret: 'b' },
  );
  assert.equal(e.PATH, 'p');
  assert.equal(e.KIROCREW_PROXY_SECRET, undefined);
  assert.equal(e.kirocrew_gateway_origin_proof, undefined);
  assert.equal(e.PORT, undefined);
  assert.equal(e.VSCODE_IPC_HOOK_CLI, undefined);
  assert.equal(e.KIROCREW_SPAWNED, '1', 'reap markers survive');
  assert.equal(e.KIROCREW_SPAWN_INSTANCE, 'i');
  assert.equal(e.KIROCREW_VSCODE_BRIDGE_URL, 'http://127.0.0.1:9');
  assert.equal(e.KIROCREW_VSCODE_BRIDGE_SECRET, 'b');
});

test('toFolderParam and workbenchUrl', () => {
  assert.equal(toFolderParam('C:\\Users\\me\\proj'), '/C:/Users/me/proj');
  assert.equal(toFolderParam('/home/me'), '/home/me');
  assert.equal(toFolderParam('relative/x'), null);
  assert.equal(toFolderParam(''), null);
  assert.equal(workbenchUrl({ port: 5, basePath: '/vsc-k', folder: 'C:\\a b' }), 'http://127.0.0.1:5/vsc-k/?folder=%2FC%3A%2Fa%20b');
  assert.equal(workbenchUrl({ port: 5, basePath: '/vsc-k' }), 'http://127.0.0.1:5/vsc-k/');
});

// ---------------------------------------------------------------- auth
test('verifyProxySignature accepts the gateway format and rejects tampering', () => {
  const secret = 'app-secret';
  const now = 1_700_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const body = Buffer.from('{"path":"x"}');
  const header = signProxyRequest({ secret, ts, method: 'POST', target: '/api/open?a=1', body });
  const ok = (o) => verifyProxySignature({ secret, header, method: 'POST', target: '/api/open?a=1', body, now, ...o });
  assert.equal(ok({}), true);
  assert.equal(ok({ method: 'GET' }), false);
  assert.equal(ok({ target: '/api/open' }), false);
  assert.equal(ok({ body: Buffer.from('{}') }), false);
  assert.equal(ok({ secret: 'other' }), false);
  assert.equal(ok({ now: now + 61_000 }), false, 'stale');
  assert.equal(ok({ now: now - 61_000 }), false, 'future');
  assert.equal(ok({ header: 'junk' }), false);
  assert.equal(ok({ header: undefined }), false);
  assert.equal(ok({ secret: '' }), false);
});

test('signProxyRequest matches a known HMAC vector (gateway formula)', () => {
  // msg = "ts:METHOD:target:sha256(body)"; GET with empty body.
  const header = signProxyRequest({ secret: 'k', ts: '100', method: 'GET', target: '/api/session', body: Buffer.alloc(0) });
  // Computed independently with Python: hmac.new(b"k", b"100:GET:/api/session:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", sha256)
  assert.equal(header, '100:11b41bdcb986348c3667cc99a6c9287b36b70b31a762b962eb635bc2d034fbff');
});

test('checkBridgeSecret is exact', () => {
  assert.equal(checkBridgeSecret('abc', 'abc'), true);
  assert.equal(checkBridgeSecret('abc', 'abd'), false);
  assert.equal(checkBridgeSecret('abc', 'abcd'), false);
  assert.equal(checkBridgeSecret('abc', undefined), false);
  assert.equal(checkBridgeSecret('', ''), false);
  assert.notEqual(randomSecret(), randomSecret());
  assert.ok(randomSecret(24).length >= 32);
});

// ---------------------------------------------------------------- routing
test('matchRoute assigns auth per route', () => {
  assert.deepEqual(matchRoute('GET', '/health', '/vsc-k'), { name: 'health', auth: 'none' });
  assert.deepEqual(matchRoute('GET', '/api/session', '/vsc-k'), { name: 'session', auth: 'proxy' });
  assert.deepEqual(matchRoute('POST', '/api/open', '/vsc-k'), { name: 'open', auth: 'proxy' });
  assert.deepEqual(matchRoute('GET', '/api/bridge/commands', '/vsc-k'), { name: 'bridgeCommands', auth: 'bridge' });
  assert.deepEqual(matchRoute('POST', '/api/bridge/events', '/vsc-k'), { name: 'bridgeEvents', auth: 'bridge' });
  assert.deepEqual(matchRoute('GET', '/vsc-k/', '/vsc-k'), { name: 'frame', auth: 'frame' });
  assert.deepEqual(matchRoute('GET', '/vsc-k/static/x.js', '/vsc-k'), { name: 'frame', auth: 'frame' });
  assert.deepEqual(matchRoute('GET', '/vsc-kX/', '/vsc-k'), { error: 404 }, 'prefix must end at a segment');
  assert.deepEqual(matchRoute('GET', '/', '/vsc-k'), { error: 404 });
  assert.deepEqual(matchRoute('GET', '/api/open', '/vsc-k'), { error: 405 });
  assert.deepEqual(matchRoute('POST', '/health', '/vsc-k'), { error: 405 });
  for (const r of ROUTES) if (r.path.startsWith('/api/') && !r.path.startsWith('/api/bridge/')) assert.equal(r.auth, 'proxy', r.path);
  for (const r of ROUTES) if (r.path.startsWith('/api/bridge/')) assert.equal(r.auth, 'bridge', r.path);
});

test('parseOpenRequest validates input', () => {
  assert.deepEqual(parseOpenRequest({ path: ' C:\\a.txt ', line: '3', column: 2 }), { command: { kind: 'openFile', path: 'C:\\a.txt', line: 3, column: 2 } });
  assert.deepEqual(parseOpenRequest({ kind: 'openFolder', path: '/x' }), { command: { kind: 'openFolder', path: '/x' } });
  assert.ok(parseOpenRequest({}).error);
  assert.ok(parseOpenRequest(null).error);
  assert.ok(parseOpenRequest({ path: 'a', line: 0 }).error);
  assert.ok(parseOpenRequest({ path: 'a', line: 1.5 }).error);
  assert.ok(parseOpenRequest({ path: 'a\0b' }).error);
  assert.ok(parseOpenRequest({ path: 'a', kind: 'rm' }).error);
});

test('fileMenuToCommand maps file rows and folder rows', () => {
  assert.deepEqual(fileMenuToCommand({ item_id: 'open-in-vscode', surface: 'file-overflow', path: '/a.md', kind: 'file' }), { command: { kind: 'openFile', path: '/a.md' } });
  assert.deepEqual(fileMenuToCommand({ surface: 'tree-context', path: '/d', kind: 'dir' }), { command: { kind: 'openFolder', path: '/d' } });
  assert.deepEqual(fileMenuToCommand({ surface: 'folder-row', path: '/d' }), { command: { kind: 'openFolder', path: '/d' } });
  assert.ok(fileMenuToCommand({ surface: 'file-overflow' }).error);
});

// ---------------------------------------------------------------- bridge
test('Bridge delivers a queued command to a waiting poll and resolves its result', async () => {
  const b = new Bridge();
  const poll = b.take(5000);
  assert.equal(b.connected, true, 'an active poll counts as connected');
  const { id, done } = b.enqueue({ kind: 'openFile', path: '/a' }, 2000);
  const batch = await poll;
  assert.deepEqual(batch, [{ id, kind: 'openFile', path: '/a' }]);
  assert.equal(b.applyEvent({ type: 'result', id, ok: true }), true);
  assert.deepEqual(await done, { id, delivered: true, ok: true, error: undefined });
});

test('Bridge keeps commands queued until a poll arrives; timeout reports undelivered', async () => {
  const b = new Bridge();
  const { done } = b.enqueue({ kind: 'openFile', path: '/a' }, 30);
  const r = await done;
  assert.equal(r.timeout, true);
  assert.equal(r.delivered, false);
  assert.equal((await b.take(10)).length, 1, 'still queued for the next poll');
});

test('Bridge poll abort consumes nothing; requeue restores order', async () => {
  const b = new Bridge();
  const ac = new AbortController();
  const p = b.take(5000, ac.signal);
  ac.abort();
  assert.deepEqual(await p, []);
  b.enqueue({ kind: 'openFile', path: '/1' }, 10);
  b.enqueue({ kind: 'openFile', path: '/2' }, 10);
  const batch = await b.take(10);
  b.requeue(batch);
  assert.deepEqual((await b.take(10)).map((c) => c.path), ['/1', '/2']);
});

test('Bridge connected window and editor events', () => {
  let t = 1000;
  const b = new Bridge({ now: () => t, connectedWindowMs: 100 });
  assert.equal(b.connected, false);
  b.applyEvent({ type: 'hello', version: '0.1.0', workspaceFolders: ['/w'] });
  assert.equal(b.connected, true);
  b.applyEvent({ type: 'editor', path: '/w/a.js', languageId: 'javascript', selection: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 4 } });
  b.applyEvent({ type: 'saved', path: '/w/a.js' });
  const s = b.snapshot();
  assert.equal(s.activeEditor.path, '/w/a.js');
  assert.equal(s.activeEditor.selection.startLine, 3);
  assert.equal(s.lastSaved.path, '/w/a.js');
  assert.deepEqual(s.extension.workspaceFolders, ['/w']);
  b.applyEvent({ type: 'editor', path: null });
  assert.equal(b.snapshot().activeEditor, null);
  assert.equal(b.applyEvent({ type: 'bogus' }), false);
  assert.equal(b.applyEvent(null), false);
  t += 500;
  assert.equal(b.connected, false);
});

// ---------------------------------------------------------------- extensions.json
test('upsertBridgeEntry replaces old bridge entries and keeps others', () => {
  const existing = [
    { identifier: { id: 'ms-python.python' }, version: '1', location: { $mid: 1, path: '/x', scheme: 'file' }, relativeLocation: 'ms-python.python-1' },
    { identifier: { id: 'Kiro-Crew.Kiro-Crew-Bridge' }, version: '0.0.1', location: { $mid: 1, path: '/old', scheme: 'file' } },
  ];
  const out = upsertBridgeEntry(existing, { version: '0.1.0', folderPath: 'C:\\d\\ext\\' + bridgeFolderName('0.1.0'), folderName: bridgeFolderName('0.1.0'), now: 5 });
  assert.equal(out.length, 2);
  assert.equal(out[0].identifier.id, 'ms-python.python');
  const mine = out[1];
  assert.equal(mine.identifier.id, BRIDGE_ID);
  assert.equal(mine.version, '0.1.0');
  assert.equal(mine.relativeLocation, 'kiro-crew.kiro-crew-bridge-0.1.0');
  assert.deepEqual(mine.location, { $mid: 1, path: '/c:/d/ext/kiro-crew.kiro-crew-bridge-0.1.0', scheme: 'file' });
  assert.deepEqual(upsertBridgeEntry('not an array', { version: '1', folderPath: '/e/x', folderName: 'x' }).length, 1);
});

test('staleBridgeFolders and fileUriComponents', () => {
  assert.deepEqual(staleBridgeFolders(['kiro-crew.kiro-crew-bridge-0.0.9', 'kiro-crew.kiro-crew-bridge-0.1.0', 'other-1'], 'kiro-crew.kiro-crew-bridge-0.1.0'), ['kiro-crew.kiro-crew-bridge-0.0.9']);
  assert.deepEqual(fileUriComponents('/home/x'), { $mid: 1, path: '/home/x', scheme: 'file' });
});

// ---------------------------------------------------------------- frame proxy headers
test('upstreamHeaderPairs drops browser cookies and injects only the token', () => {
  const raw = ['Host', '127.0.0.1:1', 'Cookie', 'mc_token_5476=secret; other=1', 'X-Forwarded-Prefix', '/evil', 'Connection', 'Upgrade', 'Upgrade', 'websocket', 'Accept', '*/*'];
  const plain = upstreamHeaderPairs(raw, 'TKN');
  assert.deepEqual(plain, [['Host', '127.0.0.1:1'], ['Accept', '*/*'], ['Cookie', 'vscode-tkn=TKN']]);
  const ws = upstreamHeaderPairs(raw, 'TKN', { keepHop: true });
  assert.ok(ws.some(([k]) => k === 'Upgrade'));
  assert.ok(!ws.some(([, v]) => String(v).includes('mc_token')));
});

test('filterSetCookie removes the token cookie only', () => {
  assert.equal(filterSetCookie(['vscode-tkn=abc; SameSite=Lax']), undefined);
  assert.deepEqual(filterSetCookie(['vscode-tkn=abc', 'a=1']), ['a=1']);
  assert.equal(filterSetCookie(undefined), undefined);
});

// ---------------------------------------------------------------- provisioning (local)
test('downloadFile follows a redirect and extractArchive unpacks a zip build', { skip: process.platform !== 'win32' && 'zip via bsdtar checked on Windows' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-prov-'));
  try {
    // Build a tiny fake server archive: vscode-server-win32-x64-web/{node.exe,out/server-main.js}
    const src = path.join(tmp, 'src', 'vscode-server-win32-x64-web');
    fs.mkdirSync(path.join(src, 'out'), { recursive: true });
    fs.writeFileSync(path.join(src, 'node.exe'), 'x');
    fs.writeFileSync(path.join(src, 'out', 'server-main.js'), '//');
    const zip = path.join(tmp, 'server.zip');
    const r = spawnSync(tarCommand(), ['-a', '-cf', zip, '-C', path.join(tmp, 'src'), 'vscode-server-win32-x64-web'], { windowsHide: true });
    assert.equal(r.status, 0, String(r.stderr));
    const srv = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/file.zip' });
        return res.end();
      }
      res.writeHead(200, { 'content-length': fs.statSync(zip).size });
      fs.createReadStream(zip).pipe(res);
    });
    await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
    const dest = path.join(tmp, 'dl.zip');
    const { bytes } = await downloadFile(`http://127.0.0.1:${srv.address().port}/redirect`, dest);
    srv.close();
    assert.equal(bytes, fs.statSync(zip).size);
    const out = path.join(tmp, 'out');
    await extractArchive(dest, out);
    const rootDir = locateBuildRoot(out);
    assert.equal(rootDir, path.join(out, 'vscode-server-win32-x64-web'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
