// The launcher with tabs, end to end (a stand-in server build and the mock
// gateway, as in test/native.test.mjs): every VS Code window takes its own
// commands, a file goes to the tab whose folder holds it, a folder opens as a
// tab, a window can claim only a tab the page has, and a tab follows its window
// to another folder.
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

test('launcher: tabs route commands to their own windows, and the file menu opens tabs', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-tabs-'));
  const serverDir = path.join(dataDir, 'server');
  fakeServerBuild(serverDir);
  const a = path.join(dataDir, 'proj a');
  const b = path.join(dataDir, 'proj-b');
  const c = path.join(dataDir, 'proj-c');
  for (const d of [a, b, c, path.join(a, 'src')]) fs.mkdirSync(d, { recursive: true });
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
      VSCODE_PANE_WORKSPACE: a,
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
    const text = await r.text();
    return { status: r.status, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  const hello = (host, folder, tab) => bridge('POST', '/api/bridge/events', { type: 'hello', host, workspaceFolders: [folder], ...(tab !== undefined ? { tab } : {}) }, host);
  const commands = async (host) => (await bridge('GET', `/api/bridge/commands?wait=0&host=${host}`, undefined, host)).json.commands;
  try {
    for (let i = 0; i < 200 && !fs.existsSync(path.join(serverDir, 'bridge.json')); i++) await sleep(50);
    br = JSON.parse(fs.readFileSync(path.join(serverDir, 'bridge.json'), 'utf8'));
    let s = null;
    for (let i = 0; i < 200 && !(s && s.ready); i++) {
      s = (await proxy('GET', '/api/session')).json;
      if (!(s && s.ready)) await sleep(50);
    }
    assert.ok(s.ready, 'the stand-in server is up');
    const ta = (await proxy('POST', '/api/tabs/open', { folder: a, reuse: true })).json.tab;
    const tb = (await proxy('POST', '/api/tabs/open', { folder: b, session: 'chat-b' })).json.tab;
    s = (await proxy('GET', '/api/session')).json;
    assert.deepEqual(s.tabs.list.map((t) => [t.id, t.session]), [[ta.id, null], [tb.id, 'chat-b']]);
    assert.equal(s.tabs.active, tb.id);
    for (const t of s.tabs.list) assert.match(t.url, new RegExp(`/\\?folder=${encodeURIComponent(t.folder).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    assert.equal(new URL(s.url).searchParams.get('folder'), b, 'the session url is the front tab\'s');

    // Two windows. Window A has said which tab it is; window B has not yet.
    await hello('wa', a, ta.id);
    await hello('wb', b);
    // A window can only claim a tab the page has open.
    await bridge('POST', '/api/bridge/events', { type: 'tab', tab: 'tffffffffffff' }, 'wb');
    // A file goes to the tab whose folder holds it (the deepest), and that tab comes to the front.
    let open = proxy('POST', '/api/open', { path: path.join(a, 'src', 'x.js'), line: 2 });
    await sleep(150);
    assert.deepEqual(await commands('wb'), [], 'not the other window');
    const forA = await commands('wa');
    assert.deepEqual(forA.map((cmd) => [cmd.kind, cmd.path, cmd.line]), [['openFile', path.join(a, 'src', 'x.js'), 2]]);
    await bridge('POST', '/api/bridge/events', { type: 'result', id: forA[0].id, ok: true }, 'wa');
    assert.deepEqual([(await open).json.ok, (await open).json.tab], [true, ta.id]);
    assert.equal((await proxy('GET', '/api/session')).json.tabs.active, ta.id);
    // Window B has no tab yet: a command for tab B reaches it through its folder.
    open = proxy('POST', '/api/open', { path: path.join(b, 'y.md') });
    await sleep(150);
    assert.deepEqual(await commands('wa'), []);
    const forB = await commands('wb');
    assert.equal(forB[0].path, path.join(b, 'y.md'));
    await bridge('POST', '/api/bridge/events', { type: 'result', id: forB[0].id, ok: true }, 'wb');
    assert.equal((await open).json.tab, tb.id);
    // Once it says its tab, the page's reveal for that tab goes to it.
    await bridge('POST', '/api/bridge/events', { type: 'tab', tab: tb.id }, 'wb');
    const reveal = proxy('POST', '/api/crew/view', { action: 'reveal', tab: tb.id });
    await sleep(150);
    assert.deepEqual(await commands('wa'), []);
    const rv = await commands('wb');
    assert.deepEqual(rv.map((cmd) => cmd.kind), ['revealCrewView']);
    await bridge('POST', '/api/bridge/events', { type: 'result', id: rv[0].id, ok: true }, 'wb');
    assert.equal((await reveal).json.ok, true);
    // Each window's own editor in /api/state.
    await bridge('POST', '/api/bridge/events', { type: 'editor', path: path.join(a, 'src', 'x.js'), selection: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 1 } }, 'wa');
    await bridge('POST', '/api/bridge/events', { type: 'editor', path: path.join(b, 'y.md') }, 'wb');
    assert.equal((await proxy('GET', `/api/state?tab=${ta.id}`)).json.activeEditor.path, path.join(a, 'src', 'x.js'));
    assert.equal((await proxy('GET', `/api/state?tab=${tb.id}`)).json.activeEditor.path, path.join(b, 'y.md'));
    // The Kiro Crew view of each window: the chat's tab shows the chat, the other the session list.
    assert.equal((await bridge('GET', `/api/bridge/kc?tab=${tb.id}`, undefined, 'wb')).json.embedPath, '/embed/chat/chat-b?sid=chat-b');
    assert.equal((await bridge('GET', `/api/bridge/kc?tab=${ta.id}`, undefined, 'wa')).json.embedPath, '/embed/sessions');

    // The file menu: a folder opens as a tab of its own, and the answer links to it.
    const fm = (await proxy('POST', '/api/file-menu', { item_id: 'open-in-vscode', surface: 'folder-row', path: c, kind: 'dir' })).json;
    s = (await proxy('GET', '/api/session')).json;
    const tc = s.tabs.list.find((t) => t.folder === c);
    assert.ok(tc && s.tabs.active === tc.id && !tc.session, JSON.stringify(s.tabs));
    assert.match(fm.url, new RegExp(`/apps/vscode-pane\\?tab=${tc.id}$`));
    assert.match(fm.message, /in a VS Code tab/);
    assert.equal((await proxy('POST', '/api/file-menu', { item_id: 'open-in-vscode', surface: 'folder-row', path: c, kind: 'dir' })).json.url, fm.url, 'the same folder gets the same tab');
    // A file outside every tab's folder, with the project root the menu names: a tab on that root.
    const elsewhere = path.join(dataDir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const fm2 = (await proxy('POST', '/api/file-menu', { item_id: 'open-in-vscode', surface: 'file-overflow', path: path.join(elsewhere, 'z.txt'), kind: 'file', root: elsewhere })).json;
    const te = (await proxy('GET', '/api/session')).json.tabs.list.find((t) => t.folder === elsewhere);
    assert.ok(te, 'a tab on the root');
    assert.match(fm2.url, new RegExp(`\\?tab=${te.id}$`));
    // A chat whose project folder is gone still gets its tab, on the default folder.
    const lost = (await proxy('POST', '/api/tabs/open', { folder: path.join(dataDir, 'deleted'), session: 'chat-gone' })).json;
    assert.equal(lost.tab.folder, a);
    assert.match(lost.note, /is not a folder on this machine any more/);

    // The window of tab A opened another folder itself: the tab follows it.
    await hello('wa', c, ta.id);
    assert.equal((await proxy('GET', '/api/session')).json.tabs.list.find((t) => t.id === ta.id).folder, c);
    // Closing tabs: the front tab moves to the right neighbour.
    assert.equal((await proxy('POST', '/api/tabs/activate', { id: tb.id })).json.tabs.active, tb.id);
    const closed = (await proxy('POST', '/api/tabs/close', { id: tb.id })).json;
    assert.equal(closed.tabs.active, tc.id);
    assert.equal((await proxy('POST', '/api/tabs/close', { id: tb.id })).status, 404);
    assert.equal((await proxy('POST', '/api/tabs/close', { id: 'nope' })).status, 400);
    // Kept on disk for the next launcher run.
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'data', 'state', 'tabs.json'), 'utf8'));
    assert.deepEqual(saved.tabs.map((t) => t.id), [ta.id, tc.id, te.id, lost.tab.id]);
  } finally {
    child.kill();
    await sleep(200);
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
