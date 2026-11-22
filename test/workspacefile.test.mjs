// A folder that holds a `.code-workspace` file opens that workspace in place of the
// folder (backend/lib/workspacefile.mjs, lib/args.mjs workbenchUrl, backend/launcher.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findWorkspaceFile, workspaceFileFinder } from '../backend/lib/workspacefile.mjs';
import { workbenchUrl, toFolderParam } from '../backend/lib/args.mjs';
import { Bridge } from '../backend/lib/bridge.mjs';
import { signProxyRequest } from '../backend/lib/auth.mjs';
import { createGatewayMock } from './support/gateway-mock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));
const touch = (file, text = '{"folders":[{"path":"."}]}\n') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};

// ---------------------------------------------------------------- finding the file

test('findWorkspaceFile: the workspace file directly inside a folder, and nothing for a folder without one', () => {
  const d = tmp('vscp-ws-');
  try {
    assert.equal(findWorkspaceFile(d), null, 'an empty folder');
    assert.equal(findWorkspaceFile(path.join(d, 'missing')), null, 'a folder that is gone');
    assert.equal(findWorkspaceFile(''), null);
    assert.equal(findWorkspaceFile(undefined), null);
    touch(path.join(d, 'src', 'deep.code-workspace'));
    touch(path.join(d, 'notes.txt'), 'x');
    assert.equal(findWorkspaceFile(d), null, 'a workspace file below the folder is not the folder\'s');
    fs.mkdirSync(path.join(d, 'a-directory.code-workspace'));
    assert.equal(findWorkspaceFile(d), null, 'a directory with that name is not a workspace file');
    touch(path.join(d, '.code-workspace'));
    assert.equal(findWorkspaceFile(d), null, 'the suffix alone is not a name');
    const one = touch(path.join(d, 'app.code-workspace'));
    assert.equal(findWorkspaceFile(d), one);
    assert.equal(findWorkspaceFile(`${d}${path.sep}`), path.join(`${d}${path.sep}`, 'app.code-workspace'), 'a trailing separator is fine');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('findWorkspaceFile: several files give one answer, the one named after the folder first', () => {
  const root = tmp('vscp-ws-');
  try {
    const d = path.join(root, 'My App');
    touch(path.join(d, 'zeta.code-workspace'));
    touch(path.join(d, 'Beta.code-workspace'));
    touch(path.join(d, 'alpha.code-workspace'));
    assert.equal(findWorkspaceFile(d), path.join(d, 'alpha.code-workspace'), 'the first by name, ignoring case');
    touch(path.join(d, 'my app.CODE-WORKSPACE'));
    assert.equal(findWorkspaceFile(d), path.join(d, 'my app.CODE-WORKSPACE'), 'the file named after the folder wins, whatever the case');
    assert.equal(findWorkspaceFile(d), findWorkspaceFile(d), 'the same folder always gives the same file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findWorkspaceFile: a symlink counts when it points at a file, and names the workbench cannot carry are skipped', { skip: process.platform === 'win32' && 'symlinks need a privilege on Windows' }, () => {
  const d = tmp('vscp-ws-');
  try {
    const real = touch(path.join(d, 'real', 'shared.code-workspace'));
    fs.mkdirSync(path.join(d, 'proj'));
    fs.symlinkSync(real, path.join(d, 'proj', 'link.code-workspace'));
    fs.symlinkSync(path.join(d, 'nowhere'), path.join(d, 'proj', 'a-broken.code-workspace'));
    fs.symlinkSync(path.join(d, 'real'), path.join(d, 'proj', 'a-dir.code-workspace'));
    assert.equal(findWorkspaceFile(path.join(d, 'proj')), path.join(d, 'proj', 'link.code-workspace'), 'only the link to a file');
    touch(path.join(d, 'odd', 'back\\slash.code-workspace'));
    touch(path.join(d, 'odd', 'new\nline.code-workspace'));
    assert.equal(findWorkspaceFile(path.join(d, 'odd')), null, 'a backslash or a control character in the name');
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('workspaceFileFinder asks the disk once per folder per interval', () => {
  let t = 1000;
  const calls = [];
  const find = workspaceFileFinder({ ttlMs: 5000, now: () => t, find: (f) => (calls.push(f), f === '/w/a' ? '/w/a/a.code-workspace' : null) });
  assert.equal(find('/w/a'), '/w/a/a.code-workspace');
  assert.equal(find('/w/a'), '/w/a/a.code-workspace');
  assert.equal(find('/w/b'), null);
  assert.equal(find('/w/b'), null, 'a folder with no file is remembered too');
  assert.deepEqual(calls, ['/w/a', '/w/b']);
  t += 4999;
  find('/w/a');
  assert.equal(calls.length, 2);
  t += 2;
  find('/w/a');
  assert.deepEqual(calls, ['/w/a', '/w/b', '/w/a'], 'asked again once the interval is over');
  assert.equal(find(''), null);
  assert.equal(find(null), null);
  assert.equal(calls.length, 3, 'no folder, no question');
  const small = workspaceFileFinder({ max: 2, now: () => t, find: (f) => (calls.push(f), null) });
  for (const f of ['/x/1', '/x/2', '/x/3']) small(f);
  assert.equal(calls.length, 6);
});

// ---------------------------------------------------------------- the URL

test('workbenchUrl opens a workspace file with ?workspace= in place of the folder', () => {
  assert.equal(workbenchUrl({ port: 5, basePath: '/vsc-k', folder: '/p/app', workspaceFile: '/p/app/app.code-workspace' }), 'http://127.0.0.1:5/vsc-k/?workspace=%2Fp%2Fapp%2Fapp.code-workspace');
  assert.equal(workbenchUrl({ port: 5, basePath: '/vsc-k', folder: '/p/app', workspaceFile: null }), 'http://127.0.0.1:5/vsc-k/?folder=%2Fp%2Fapp');
  assert.equal(workbenchUrl({ port: 5, basePath: '/vsc-k', folder: '/p/app' }), 'http://127.0.0.1:5/vsc-k/?folder=%2Fp%2Fapp');
  // Windows paths take the form a folder does: forward slashes and a leading slash.
  assert.equal(workbenchUrl({ port: 5, basePath: '/vsc-k', folder: 'C:\\a b', workspaceFile: 'C:\\a b\\x y.code-workspace' }), 'http://127.0.0.1:5/vsc-k/?workspace=%2FC%3A%2Fa%20b%2Fx%20y.code-workspace');
  // Anything that is not an absolute path is not a workspace; the folder is used.
  assert.equal(workbenchUrl({ port: 5, basePath: '/vsc-k', folder: '/p/app', workspaceFile: 'app.code-workspace' }), 'http://127.0.0.1:5/vsc-k/?folder=%2Fp%2Fapp');
  // A name with URL syntax in it stays inside the one query value.
  const nasty = workbenchUrl({ port: 5, basePath: '/vsc-k', workspaceFile: '/p/a&b#c?d%e.code-workspace' });
  assert.equal(new URL(nasty).searchParams.get('workspace'), '/p/a&b#c?d%e.code-workspace');
  assert.equal(new URL(nasty).origin, 'http://127.0.0.1:5');
  assert.equal(new URL(nasty).hash, '');
});

// ---------------------------------------------------------------- the bridge

test('Bridge keeps the workspace file a window is on, and a window on one answers for its file\'s folder', () => {
  const T = 't000000000001';
  const b = new Bridge();
  b.applyEvent({ type: 'hello', host: 'w', workspaceFolders: ['/elsewhere/shared'], workspaceFile: '/p/app/app.code-workspace' });
  assert.equal(b.extension.workspaceFile, '/p/app/app.code-workspace');
  assert.equal(b.hosts.get('w').workspaceFile, '/p/app/app.code-workspace');
  assert.equal(b.hostForTab(T), null);
  b.enqueue({ kind: 'openFile', path: '/p/app/x.js' }, 50, { tab: T, folder: '/p/app' });
  assert.equal(b.designee({ tab: T, folder: '/p/app' }), 'w', 'a window with no tab yet, on a workspace file in the tab\'s folder');
  assert.notEqual(b.designee({ tab: T, folder: '/p/other' }), 'w');
  b.applyEvent({ type: 'hello', host: 'w', workspaceFolders: ['/p/app'] });
  assert.equal(b.hosts.get('w').workspaceFile, null, 'a folder window has none');
  assert.equal(b.extension.workspaceFile, null);
  b.applyEvent({ type: 'hello', host: 'w', workspaceFolders: ['/p/app'], workspaceFile: 42 });
  assert.equal(b.hosts.get('w').workspaceFile, null, 'only a path counts');
});

// ---------------------------------------------------------------- the launcher

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

/** A stand-in server build that answers /version and writes the bridge address and secret it got to bridge.json. */
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

test('launcher: a tab on a folder with a workspace file loads the workspace, and its window stays on the folder', async () => {
  const dataDir = tmp('vscp-wsfile-');
  const serverDir = path.join(dataDir, 'server');
  fakeServerBuild(serverDir);
  const withWs = path.join(dataDir, 'with ws');
  const plain = path.join(dataDir, 'plain');
  const moved = path.join(dataDir, 'moved');
  const wsFile = touch(path.join(withWs, 'with ws.code-workspace'));
  touch(path.join(withWs, 'aaa.code-workspace'));
  const movedFile = touch(path.join(moved, 'x.code-workspace'));
  fs.mkdirSync(plain, { recursive: true });
  const secret = crypto.randomBytes(16).toString('hex');
  const mock = createGatewayMock({ appName: 'vscode-pane', secret });
  const origin = await mock.listen();
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'backend', 'launcher.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      KIROCREW_PROXY_SECRET: secret,
      KIROCREW_APP_NAME: 'vscode-pane',
      KIROCREW_GATEWAY_ORIGIN: origin,
      KIROCREW_HOME: path.join(dataDir, 'no-kiro-crew-home'),
      VSCODE_PANE_DATA_DIR: path.join(dataDir, 'data'),
      VSCODE_PANE_SERVER_DIR: serverDir,
      VSCODE_PANE_WORKSPACE: plain,
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
  const bridge = async (method, p, body, host) => {
    const r = await fetch(base + p, { method, headers: { 'x-kiro-bridge-secret': br.secret, ...(host ? { 'x-kiro-bridge-host': host } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status };
  };
  const hello = (host, folders, tab, workspaceFile) => bridge('POST', '/api/bridge/events', { type: 'hello', host, workspaceFolders: folders, tab, ...(workspaceFile ? { workspaceFile } : {}) }, host);
  const params = (url) => {
    if (!url) return { folder: null, workspace: null };
    const u = new URL(url);
    return { folder: u.searchParams.get('folder'), workspace: u.searchParams.get('workspace') };
  };
  const tabNow = async (id) => (await proxy('GET', '/api/session')).json.tabs.list.find((t) => t.id === id);
  try {
    for (let i = 0; i < 200 && !fs.existsSync(path.join(serverDir, 'bridge.json')); i++) await sleep(50);
    br = JSON.parse(fs.readFileSync(path.join(serverDir, 'bridge.json'), 'utf8'));
    let s = null;
    for (let i = 0; i < 200 && !(s && s.ready); i++) {
      s = (await proxy('GET', '/api/session')).json;
      if (!(s && s.ready)) await sleep(50);
    }
    assert.ok(s.ready, 'the stand-in server is up');

    const tw = (await proxy('POST', '/api/tabs/open', { folder: withWs })).json.tab;
    const tp = (await proxy('POST', '/api/tabs/open', { folder: plain })).json.tab;
    s = (await proxy('GET', '/api/session')).json;
    const urlOf = (id) => s.tabs.list.find((t) => t.id === id).url;
    assert.deepEqual(params(urlOf(tw.id)), { folder: null, workspace: toFolderParam(wsFile) }, 'the file named after the folder, not the first by name');
    assert.deepEqual(params(urlOf(tp.id)), { folder: toFolderParam(plain), workspace: null }, 'a folder with none opens as a folder');
    assert.deepEqual(params(s.url), { folder: toFolderParam(plain), workspace: null }, 'the session url is the front tab\'s');
    assert.equal(s.tabs.list.find((t) => t.id === tw.id).folder, withWs, 'the tab is still on the folder');
    await proxy('POST', '/api/tabs/activate', { id: tw.id });
    assert.deepEqual(params((await proxy('GET', '/api/session')).json.url), { folder: null, workspace: toFolderParam(wsFile) });
    // The file menu's "Open in VS Code" on that folder finds the tab that is on it.
    const fm = (await proxy('POST', '/api/file-menu', { item_id: 'open-in-vscode', surface: 'folder-row', path: withWs, kind: 'dir' })).json;
    assert.match(fm.url, new RegExp(`\\?tab=${tw.id}$`));

    // The window of that tab is on the workspace file; the workspace lists another folder first.
    await hello('wa', [path.join(dataDir, 'shared'), withWs], tw.id, wsFile);
    assert.equal((await tabNow(tw.id)).folder, withWs, 'a window on the folder\'s workspace file keeps its tab on the folder');
    // The user opens a workspace file from another folder: the tab follows to that folder.
    await hello('wa', [plain], tw.id, movedFile);
    const followed = await tabNow(tw.id);
    assert.equal(followed.folder, moved);
    assert.deepEqual(params(followed.url), { folder: null, workspace: toFolderParam(movedFile) });
    // Then a plain folder: the tab follows it as before.
    await hello('wa', [plain], tw.id);
    const back = await tabNow(tw.id);
    assert.equal(back.folder, plain);
    assert.deepEqual(params(back.url), { folder: toFolderParam(plain), workspace: null });
    // A workspace file added to a folder shows in the next URL.
    const added = touch(path.join(plain, 'plain.code-workspace'));
    let url = '';
    for (let i = 0; i < 80 && params(url).workspace !== toFolderParam(added); i++) {
      await sleep(100);
      url = (await tabNow(tp.id)).url;
    }
    assert.deepEqual(params(url), { folder: null, workspace: toFolderParam(added) });
  } finally {
    child.kill();
    await sleep(200);
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
