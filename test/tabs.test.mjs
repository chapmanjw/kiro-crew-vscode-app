// The page's tabs (backend/lib/tabs.mjs) and the pure helpers the page uses
// for them (ui/vscode-pane-core-*.mjs): one VS Code window per tab, a chat's
// tab found again by its session, and the URL intents that open them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TabStore, parseTabs, validFolder, validSessionKey, validTabId, sameFolder, MAX_TABS, newTabId } from '../backend/lib/tabs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreFile = fs.readdirSync(path.join(ROOT, 'ui')).find((f) => /^vscode-pane-core-.*\.mjs$/.test(f));
const core = await import(pathToFileURL(path.join(ROOT, 'ui', coreFile)).href);

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsp-tabs-'));
  return path.join(dir, 'state', 'tabs.json');
}

function store(file, start = 1000) {
  let t = start;
  let n = 0;
  return new TabStore({ file, now: () => (t += 10), newId: () => `t${String(++n).padStart(12, '0')}` });
}

test('validation: tab ids, session keys and folders', () => {
  assert.match(newTabId(), /^t[0-9a-f]{12}$/);
  assert.equal(validTabId('t0123456789ab'), 't0123456789ab');
  for (const bad of ['', 't0123', 'T0123456789ab', 't0123456789ab0', 'x0123456789ab', null, 5]) assert.equal(validTabId(bad), null, String(bad));
  for (const ok of ['chat-1795016838-ab12', 'vscode-kiro-crew-vscode-app-23c67dd6d4-d4eb9792', 'member-clio.memory-member-clio-1a']) assert.equal(validSessionKey(ok), ok);
  assert.equal(validSessionKey('dashboard:chat-1'), 'chat-1', 'the dashboard prefix is dropped');
  for (const bad of ['', '-x', '.x', 'a b', 'a/b', '../x', 'a?b', 'a#b', 'a:b', 'x'.repeat(201), null, {}, 'dashboard:']) assert.equal(validSessionKey(bad), null, String(bad));
  assert.equal(validFolder(' /home/me/proj '), '/home/me/proj');
  assert.equal(validFolder('C:\\work\\proj', path.win32.isAbsolute), 'C:\\work\\proj');
  for (const bad of ['', 'relative/dir', '/a\0b', `/${'x'.repeat(4100)}`, null, 3]) assert.equal(validFolder(bad), null, String(bad).slice(0, 20));
  assert.equal(sameFolder('/a/b/', '/a/b', { win: false }), true);
  assert.equal(sameFolder('/a/B', '/a/b', { win: false }), false);
  assert.equal(sameFolder('C:\\Work\\Proj\\', 'c:\\work\\proj', { win: true }), true);
  assert.equal(sameFolder('/a', '', { win: false }), false);
});

test('TabStore: a first run is fresh; tabs open, come back by session, reuse a folder, close to the right and persist', () => {
  const file = tmpFile();
  const s = store(file);
  assert.deepEqual([s.fresh, s.list().length, s.active], [true, 0, null]);
  const a = s.open({ folder: '/w/a', reuse: true });
  assert.deepEqual([a.created, a.tab.id, a.tab.session, s.active, s.fresh], [true, 't000000000001', null, 't000000000001', false]);
  assert.equal(s.open({ folder: '/w/a/', reuse: true }).tab.id, a.tab.id, 'reuse finds the tab on the same folder');
  assert.notEqual(s.open({ folder: '/w/a', reuse: false }).tab.id, a.tab.id, 'New tab always adds one');
  const chat = s.open({ folder: '/w/a', session: 'chat-1' });
  assert.equal(chat.created, true, 'a chat gets its own tab even where a folder tab is open');
  assert.deepEqual(s.open({ folder: '/elsewhere', session: 'chat-1' }), { tab: s.get(chat.tab.id), created: false }, 'the same chat brings back its tab');
  assert.equal(s.active, chat.tab.id);
  assert.equal(s.open({ folder: '/w/a', reuse: true }).tab.id, a.tab.id, 'reuse never takes a chat\'s tab');
  // Closing the front tab: the one to its right takes its place, else the one to its left.
  s.activate('t000000000002');
  s.close('t000000000002');
  assert.equal(s.active, chat.tab.id);
  s.close(chat.tab.id);
  assert.equal(s.active, a.tab.id);
  assert.equal(s.close('t000000000099'), false);
  // On disk, owner-only, and read back the same.
  const again = new TabStore({ file });
  assert.deepEqual([again.fresh, again.active, again.list().map((t) => t.id)], [false, a.tab.id, [a.tab.id]]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // The window opened another folder: the tab follows it.
  assert.equal(again.setFolder(a.tab.id, '/w/other'), true);
  assert.equal(new TabStore({ file }).get(a.tab.id).folder, '/w/other');
  s.close(a.tab.id);
});

test('TabStore: at most MAX_TABS; recent() picks the latest front tab', () => {
  const s = store(tmpFile());
  for (let i = 0; i < MAX_TABS; i++) assert.ok(s.open({ folder: `/w/${i}` }).tab);
  const over = s.open({ folder: '/w/x' });
  assert.equal(over.status, 409);
  assert.match(over.error, /at most 20/);
  s.activate('t000000000003');
  assert.equal(s.recent((t) => t.folder.startsWith('/w/')).id, 't000000000003');
  assert.equal(s.open({ folder: '/w/3', reuse: true }).created, false, 'reusing works at the cap');
});

test('parseTabs drops malformed entries and keeps a valid front tab', () => {
  assert.equal(parseTabs('not json'), null);
  assert.equal(parseTabs('{"tabs":5}'), null);
  const p = parseTabs(JSON.stringify({
    tabs: [
      { id: 't000000000001', folder: '/a', session: 'chat-1', createdAt: 1, activeAt: 2 },
      { id: 't000000000001', folder: '/dup' },
      { id: 'bad', folder: '/b' },
      { id: 't000000000002', folder: '' },
      { id: 't000000000003', folder: '/c', session: '../x' },
    ],
    active: 't000000000009',
  }));
  assert.deepEqual(p.tabs.map((t) => [t.id, t.folder, t.session]), [['t000000000001', '/a', 'chat-1'], ['t000000000003', '/c', null]]);
  assert.equal(p.active, 't000000000001', 'an unknown front tab falls back to the first');
});

test('appPageUrl and intentFromSearch: the chip\'s session and folder, a file menu\'s tab, a plain folder', () => {
  const { appPageUrl, intentFromSearch } = core;
  assert.equal(appPageUrl('/home/me/proj', 'dashboard:chat-1'), '/apps/vscode-pane?folder=%2Fhome%2Fme%2Fproj&session=chat-1');
  assert.equal(appPageUrl('', 'chat-1'), '/apps/vscode-pane?session=chat-1');
  assert.equal(appPageUrl('/x', 'bad key'), '/apps/vscode-pane?folder=%2Fx', 'a malformed key is left out');
  assert.deepEqual(intentFromSearch('?folder=%2Fhome%2Fme%2Fproj&session=dashboard%3Achat-1'), { folder: '/home/me/proj', session: 'chat-1', tab: '' });
  assert.deepEqual(intentFromSearch('?tab=t0123456789ab'), { folder: '', session: '', tab: 't0123456789ab' });
  assert.deepEqual(intentFromSearch('?folder=C%3A%5Cw%5Cp'), { folder: 'C:\\w\\p', session: '', tab: '' });
  assert.equal(intentFromSearch(''), null);
  assert.equal(intentFromSearch('?session=a%20b&tab=nope'), null, 'malformed values ask for nothing');
  assert.deepEqual(intentFromSearch('?folder=%2Fp&session=..%2Fx'), { folder: '/p', session: '', tab: '' });
});

test('tab labels: the chat\'s title when shared, else the folder name, repeats numbered; tooltips name the folder and chat', () => {
  const { tabLabels, tabTooltip, baseName, sessionTitles } = core;
  assert.equal(baseName('C:\\work\\My App\\'), 'My App');
  assert.equal(baseName('/home/me/proj'), 'proj');
  assert.equal(baseName('/'), '/');
  const titles = sessionTitles([{ key: 'chat-1', title: ' Fix the build ' }, { key: 'chat-2', title: '' }, null, { key: 3, title: 'x' }]);
  assert.deepEqual(titles, { 'chat-1': 'Fix the build' });
  const tabs = [
    { id: 't1', folder: '/w/proj', session: null },
    { id: 't2', folder: '/w/proj', session: 'chat-1' },
    { id: 't3', folder: '/w/proj', session: 'chat-2' },
    { id: 't4', folder: '/x/proj', session: null },
  ];
  assert.deepEqual(tabLabels(tabs, titles), { t1: 'proj', t2: 'Fix the build', t3: 'proj 2', t4: 'proj 3' });
  assert.deepEqual(tabLabels(tabs), { t1: 'proj', t2: 'proj 2', t3: 'proj 3', t4: 'proj 4' });
  assert.equal(tabTooltip(tabs[0], titles), '/w/proj');
  assert.equal(tabTooltip(tabs[1], titles), '/w/proj\nKiro Crew chat: Fix the build');
  assert.equal(tabTooltip(tabs[2], titles), '/w/proj\nKiro Crew chat: chat-2');
});

test('tab frame keys reload a tab only for Reload, a new server or launcher run, or a new way in; frame URLs follow the web origin', () => {
  const { tabFrameKey, frameUrlFor, serverStatusLine } = core;
  const k = { id: 't1', nonce: 0, instance: 'run1', generation: 2, mode: 'frame' };
  assert.equal(tabFrameKey(k), 't1#0#run1#2#frame');
  for (const change of [{ nonce: 1 }, { instance: 'run2' }, { generation: 3 }, { mode: 'origin' }, { id: 't2' }]) assert.notEqual(tabFrameKey({ ...k, ...change }), tabFrameKey(k), JSON.stringify(change));
  assert.equal(tabFrameKey({ ...k, id: '' }), null);
  const session = { webOrigin: { host: 'vscode-pane.apps.localhost', probe: '/_vscp-probe' } };
  const url = 'http://127.0.0.1:41000/vsc-KEY/?folder=%2Fw%2Fa';
  assert.equal(frameUrlFor(url, session, 'frame', { protocol: 'http:', port: '7778' }), url);
  assert.equal(frameUrlFor(url, session, 'origin', { protocol: 'http:', port: '7778' }), 'http://vscode-pane.apps.localhost:7778/vsc-KEY/?folder=%2Fw%2Fa');
  assert.equal(frameUrlFor(null, session, 'frame', {}), null);
  assert.equal(serverStatusLine({ ready: true, server: { name: '1.146.0' } }, null), 'VS Code 1.146.0 is running');
  assert.equal(serverStatusLine({ ready: false, message: 'VS Code server failed to start', error: 'boom' }, null), 'VS Code server failed to start: boom');
  assert.equal(serverStatusLine(null, null), 'Connecting to the vscode-pane backend...');
  assert.equal(serverStatusLine(null, { title: 'down', message: 'Node.js is missing' }), 'Node.js is missing');
});

test('the page answers "which tab am I in" only for windows inside its own frames, and the session control passes the chat key', () => {
  const page = fs.readFileSync(path.join(ROOT, 'ui', JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')).ui.entry), 'utf8');
  assert.match(page, /d\.vscodePane !== 'tab\?'/);
  assert.match(page, /const id = tabOfWindow\(e\.source\);\n    if \(!id\) return;/);
  assert.match(page, /e\.source\.postMessage\(\{ vscodePane: 'tab', nonce: d\.nonce, tab: id \}, e\.origin && e\.origin !== 'null' \? e\.origin : '\*'\)/);
  // The open-file form is gone; the server controls sit in the menu.
  assert.doesNotMatch(page, /vscp-open|Open file/);
  for (const id of ['vscode-pane-menu-button', 'vscode-pane-reload', 'vscode-pane-restart', 'vscode-pane-update-check', 'vscode-pane-kc-state', 'vscode-pane-crew-reveal', 'vscode-pane-new-tab', 'vscode-pane-tab-close']) assert.ok(page.includes(`'${id}'`), id);
  const control = fs.readFileSync(path.join(ROOT, 'ui', JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')).contributes.sessionControls[0].entryPoint), 'utf8');
  assert.match(control, /navigate\(appPageUrl\(cwd, key\)\)/);
  assert.match(control, /session\.sessionKey/);
});

test('each tab loads its window with ?vscpTab=<id>, and the workbench is told the tab as the kiroCrew.paneTab default', async () => {
  const { tabWorkbenchUrl } = core;
  assert.equal(tabWorkbenchUrl('http://127.0.0.1:1/vsc-K/?folder=%2Fw%20a', 't0123456789ab'), 'http://127.0.0.1:1/vsc-K/?folder=%2Fw%20a&vscpTab=t0123456789ab', 'the folder keeps its encoding');
  assert.equal(tabWorkbenchUrl('http://127.0.0.1:1/vsc-K/', 't0123456789ab'), 'http://127.0.0.1:1/vsc-K/?vscpTab=t0123456789ab');
  assert.equal(tabWorkbenchUrl('http://127.0.0.1:1/vsc-K/?folder=%2Fw', 'legacy'), 'http://127.0.0.1:1/vsc-K/?folder=%2Fw', 'no id, no change');
  assert.equal(tabWorkbenchUrl(null, 't0123456789ab'), null);
  const { injectConfigurationDefaults, PANE_TAB_SETTING } = await import('../backend/lib/frameproxy.mjs');
  const html = '<meta id="vscode-workbench-web-configuration" data-settings="{&quot;remoteAuthority&quot;:&quot;x&quot;}">';
  const out = injectConfigurationDefaults(html, 't0123456789ab');
  const json = JSON.parse(out.match(/data-settings="([^"]*)"/)[1].replace(/&quot;/g, '"'));
  assert.deepEqual(json, { configurationDefaults: { [PANE_TAB_SETTING]: 't0123456789ab' }, remoteAuthority: 'x' });
  assert.equal(injectConfigurationDefaults('<html></html>', 't0123456789ab'), null);
  for (const bad of ['', 'x', 't0123456789ab"', 'T0123456789AB', null]) assert.throws(() => injectConfigurationDefaults(html, bad), /bad tab id/, String(bad));
  const ext = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'kiro-crew-bridge', 'package.json'), 'utf8'));
  assert.equal(ext.contributes.configuration.properties[PANE_TAB_SETTING].default, '', 'the extension declares the setting the launcher sets');
  const src = fs.readFileSync(path.join(ROOT, 'extension', 'kiro-crew-bridge', 'extension.js'), 'utf8');
  assert.match(src, /inspect\('kiroCrew\.paneTab'\)/);
  assert.match(src, /const d = v && v\.defaultValue;/, 'only the launcher\'s default counts, never a user value');
  const launcher = fs.readFileSync(path.join(ROOT, 'backend', 'launcher.mjs'), 'utf8');
  assert.match(launcher, /url\.pathname === `\$\{BASE_PATH\}\/` \? validTabId\(url\.searchParams\.get\('vscpTab'\)\) : null/);
});

test('Bridge ranks windows by when their extension host started, so a lingering host that reconnects stays the older one', async () => {
  const { Bridge } = await import('../backend/lib/bridge.mjs');
  let t = 10_000;
  const b = new Bridge({ now: () => t });
  const T = 't000000000001';
  b.applyEvent({ type: 'hello', host: 'old', tab: T, startedAt: 1000, workspaceFolders: ['/w'] });
  t += 100;
  b.applyEvent({ type: 'hello', host: 'new', tab: T, startedAt: 9000, workspaceFolders: ['/w'] });
  t += 100;
  b.applyEvent({ type: 'hello', host: 'old', tab: T, startedAt: 1000, workspaceFolders: ['/w'] }); // reconnects later
  assert.equal(b.hostForTab(T), 'new');
  // A start time in the future is not believed.
  b.applyEvent({ type: 'hello', host: 'liar', tab: T, startedAt: t + 3_600_000, workspaceFolders: ['/w'] });
  assert.equal(b.hostForTab(T), 'liar', 'with no start time it ranks by its first hello, the latest');
  assert.equal(b.hosts.get('liar').startedAt, 0);
});
