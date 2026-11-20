// Whose colour theme it is: the Kiro Crew palette is scoped to a stock theme, and a
// colour theme the user picked in VS Code is never replaced (extension/kiro-crew-bridge/theme.js,
// backend/lib/theme.mjs seedThemeSettings).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kiroCrewOwnsTheme, scopedPalette, seedThemeSettings, resolveTheme, toVsCodeTheme } from '../backend/lib/theme.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const kcTheme = require('../extension/kiro-crew-bridge/theme.js');

const DARK = { kind: 'dark', vars: { '--bg': '#282a36', '--surface': '#343746', '--panel': '#21222c', '--border': '#44475a', '--text': '#f8f8f2', '--muted': '#a5a9c0', '--accent': '#bd93f9' } };
const LIGHT = { kind: 'light', vars: { '--bg': '#fbf7ef', '--surface': '#ffffff', '--panel': '#f2ecdf', '--border': '#d8cfbd', '--text': '#2b2620', '--muted': '#6f6658', '--accent': '#b4552d' } };
const vsOf = (body) => toVsCodeTheme(resolveTheme(body).theme);
const seed = (text, vs, extra) => JSON.parse(seedThemeSettings(typeof text === 'string' ? text : JSON.stringify(text), vs, extra));

// ---------------------------------------------------------------- the rule

test('kiroCrewOwnsTheme: nothing chosen, the scoped theme, and a theme the user picked', () => {
  const dark = { '[Dark Modern]': { 'editor.background': '#000000' } };
  assert.equal(kiroCrewOwnsTheme(undefined, dark), true, 'nothing chosen yet is Kiro Crew\'s to set');
  assert.equal(kiroCrewOwnsTheme('', dark), true);
  assert.equal(kiroCrewOwnsTheme(42, dark), true, 'a value that is not a theme name counts as nothing chosen');
  assert.equal(kiroCrewOwnsTheme('Dark Modern', dark), true, 'the theme Kiro Crew set');
  assert.equal(kiroCrewOwnsTheme('Default Dark Modern', dark), true, 'the same theme under its older name');
  assert.equal(kiroCrewOwnsTheme('Solarized Light', dark), false, 'a theme the user picked');
  assert.equal(kiroCrewOwnsTheme('Light Modern', dark), false, 'the other stock theme is the user\'s pick too');
  assert.equal(kiroCrewOwnsTheme('Dark Modern', { '[Default Dark Modern]': {} }), true);
});

test('kiroCrewOwnsTheme: a palette without a scope (an older build, or none) is judged by the stock themes', () => {
  const flat = { 'editor.background': '#000000', 'statusBar.background': '#111111' };
  assert.equal(kiroCrewOwnsTheme('Dark Modern', flat), true);
  assert.equal(kiroCrewOwnsTheme('Light Modern', undefined), true);
  assert.equal(kiroCrewOwnsTheme('Monokai', flat), false);
  assert.equal(kiroCrewOwnsTheme('Monokai', undefined), false);
  assert.equal(kiroCrewOwnsTheme('Monokai', { '[Monokai]': { 'editor.background': '#000000' } }), false, 'a scope the user wrote for their own theme is not Kiro Crew\'s record');
  assert.equal(kiroCrewOwnsTheme('Dark Modern', [1, 2]), true);
});

test('scopedPalette puts the palette under the theme\'s own key, and an empty one for a theme with none', () => {
  assert.deepEqual(scopedPalette('Dark Modern', { a: '#000000' }), { '[Dark Modern]': { a: '#000000' } });
  assert.deepEqual(scopedPalette('Light Modern', {}), { '[Light Modern]': {} });
  assert.deepEqual(scopedPalette('Light Modern', null), { '[Light Modern]': {} });
  assert.deepEqual(scopedPalette('Light Modern', [1]), { '[Light Modern]': {} });
  assert.deepEqual(kcTheme.scopedThemes({ '[Dark Modern]': {}, '[Monokai]': {}, editor: 1 }), ['Dark Modern']);
});

// ---------------------------------------------------------------- the launcher's seed

test('seedThemeSettings: a first start sets the theme and the scoped palette', () => {
  const out = seed('', vsOf(DARK));
  assert.equal(out['workbench.colorTheme'], 'Dark Modern');
  assert.deepEqual(Object.keys(out['workbench.colorCustomizations']), ['[Dark Modern]']);
  assert.ok(Object.keys(out['workbench.colorCustomizations']['[Dark Modern]']).length > 100);
});

test('seedThemeSettings: a theme the user picked survives a start and a Kiro Crew theme change', () => {
  const first = seedThemeSettings('{"editor.fontSize": 13}', vsOf(DARK));
  // VS Code writes the user's pick into this same file, where the setting already is.
  const picked = { ...JSON.parse(first), 'workbench.colorTheme': 'Solarized Light' };
  const again = seed(picked, vsOf(DARK));
  assert.equal(again['workbench.colorTheme'], 'Solarized Light', 'a restart keeps the pick');
  assert.equal(again['editor.fontSize'], 13);
  const flipped = seed(again, vsOf(LIGHT));
  assert.equal(flipped['workbench.colorTheme'], 'Solarized Light', 'the dashboard going light does not touch it');
  assert.deepEqual(Object.keys(flipped['workbench.colorCustomizations']), ['[Light Modern]'], 'the palette follows Kiro Crew, scoped to its own base theme');
  assert.deepEqual(flipped['workbench.colorCustomizations']['[Light Modern]'], vsOf(LIGHT).colorCustomizations);
});

test('seedThemeSettings: a pick of the other stock theme is the user\'s too, and the palette comes back when the themes match', () => {
  const dark = JSON.parse(seedThemeSettings('', vsOf(DARK)));
  const light = { ...dark, 'workbench.colorTheme': 'Light Modern' };
  assert.equal(seed(light, vsOf(DARK))['workbench.colorTheme'], 'Light Modern', 'Light Modern picked while Kiro Crew is dark stays');
  // Kiro Crew goes light: the palette is now scoped to the theme the user is on, so it applies.
  const lit = seed(light, vsOf(LIGHT));
  assert.equal(lit['workbench.colorTheme'], 'Light Modern');
  assert.deepEqual(Object.keys(lit['workbench.colorCustomizations']), ['[Light Modern]']);
});

test('seedThemeSettings: a theme Kiro Crew set follows the dashboard, and resetting the setting hands it back', () => {
  const dark = JSON.parse(seedThemeSettings('', vsOf(DARK)));
  const lit = seed(dark, vsOf(LIGHT));
  assert.equal(lit['workbench.colorTheme'], 'Light Modern', 'Kiro Crew\'s own theme follows its mode');
  assert.deepEqual(Object.keys(lit['workbench.colorCustomizations']), ['[Light Modern]'], 'the old scope is gone');
  const picked = { ...dark, 'workbench.colorTheme': 'Monokai' };
  const reset = { ...picked };
  delete reset['workbench.colorTheme'];
  assert.equal(seed(reset, vsOf(LIGHT))['workbench.colorTheme'], 'Light Modern', 'a reset setting is Kiro Crew\'s again');
});

test('seedThemeSettings: the flat palette an earlier build wrote becomes a scoped one', () => {
  const legacyOwned = { 'workbench.colorTheme': 'Dark Modern', 'workbench.colorCustomizations': { 'editor.background': '#111111', 'statusBar.background': '#222222' }, 'editor.fontSize': 12 };
  const a = seed(legacyOwned, vsOf(DARK));
  assert.equal(a['workbench.colorTheme'], 'Dark Modern');
  assert.deepEqual(Object.keys(a['workbench.colorCustomizations']), ['[Dark Modern]'], 'no flat key is left to colour another theme');
  assert.equal(a['editor.fontSize'], 12);
  const legacyPicked = { ...legacyOwned, 'workbench.colorTheme': 'Monokai' };
  const b = seed(legacyPicked, vsOf(DARK));
  assert.equal(b['workbench.colorTheme'], 'Monokai', 'a theme picked under an earlier build is kept too');
  assert.deepEqual(Object.keys(b['workbench.colorCustomizations']), ['[Dark Modern]']);
});

test('seedThemeSettings: tier "base" keeps the scope key so a pick of the other stock theme still counts', () => {
  const base = toVsCodeTheme(resolveTheme({ kind: 'dark' }).theme);
  const first = JSON.parse(seedThemeSettings('', base));
  assert.deepEqual(first['workbench.colorCustomizations'], { '[Dark Modern]': {} });
  const picked = { ...first, 'workbench.colorTheme': 'Light Modern' };
  assert.equal(seed(picked, base)['workbench.colorTheme'], 'Light Modern');
});

test('seedThemeSettings: the same input twice writes the same text, so an unchanged seed touches nothing', () => {
  const vs = vsOf(DARK);
  const once = seedThemeSettings('{"a": 1}', vs, { b: 2 });
  assert.equal(seedThemeSettings(once, vs, { b: 2 }), once);
  const picked = JSON.stringify({ ...JSON.parse(once), 'workbench.colorTheme': 'Monokai' }, null, 2) + '\n';
  assert.equal(seedThemeSettings(picked, vs, { b: 2 }), picked, 'a user\'s pick is rewritten byte for byte');
  assert.equal(seedThemeSettings('{"a": 1}', null, { b: 2 }), JSON.stringify({ a: 1, b: 2 }, null, 2) + '\n', 'no saved theme touches no theme setting');
});

// ---------------------------------------------------------------- the extension's apply

/** A `vscode` with user settings kept in a plain object, recording every write. */
function fakeVscode({ ids = ['Dark Modern', 'Light Modern'], user = {}, failOn = null } = {}) {
  const store = { ...user };
  const writes = [];
  const config = () => ({
    inspect: (key) => ({ globalValue: store[key] }),
    get: (key) => store[key],
    update: async (key, value, target) => {
      if (failOn === key) throw new Error(`cannot write ${key}`);
      writes.push([key, value, target]);
      if (value === undefined) delete store[key];
      else store[key] = value;
    },
  });
  const vscode = {
    ConfigurationTarget: { Global: 1 },
    extensions: { all: [{ packageJSON: { contributes: { themes: ids.map((id) => ({ id })) } } }] },
    workspace: { getConfiguration: config },
  };
  return { vscode, store, writes };
}

async function applyWith(fake, vs) {
  const events = [];
  const logs = [];
  const result = await kcTheme.applyTheme({
    vscode: fake.vscode,
    payload: { ...vs, signature: JSON.stringify(vs) },
    postEvent: async (ev) => events.push(ev),
    log: (m) => logs.push(m),
  });
  return { ...result, events, logs };
}

test('applyTheme: a first use writes the base theme and the scoped palette, then leaves them alone', async () => {
  const fake = fakeVscode();
  const vs = vsOf(DARK);
  const a = await applyWith(fake, vs);
  assert.deepEqual({ changed: a.changed, owned: a.owned }, { changed: true, owned: true });
  assert.equal(fake.store['workbench.colorTheme'], 'Dark Modern');
  assert.deepEqual(Object.keys(fake.store['workbench.colorCustomizations']), ['[Dark Modern]']);
  assert.equal(a.events.length, 1);
  assert.equal(a.events[0].applied, true);
  assert.equal(a.events[0].userTheme, false);
  assert.deepEqual(a.events[0].readBack, { colorTheme: 'Dark Modern', editorBackground: vs.colorCustomizations['editor.background'], count: Object.keys(vs.colorCustomizations).length });
  const writesBefore = fake.writes.length;
  const b = await applyWith(fake, vs);
  assert.equal(b.changed, false);
  assert.equal(fake.writes.length, writesBefore, 'an unchanged theme writes nothing');
  assert.match(b.logs[0], /unchanged/);
});

test('applyTheme: a theme the user picked is not replaced on load, and the palette stays for its own base theme', async () => {
  const fake = fakeVscode();
  await applyWith(fake, vsOf(DARK));
  fake.store['workbench.colorTheme'] = 'Solarized Light'; // what the picker writes
  fake.writes.length = 0;
  const a = await applyWith(fake, vsOf(DARK));
  assert.deepEqual({ changed: a.changed, owned: a.owned }, { changed: false, owned: false });
  assert.equal(fake.store['workbench.colorTheme'], 'Solarized Light');
  assert.deepEqual(fake.writes, [], 'nothing is written over the pick');
  assert.equal(a.events[0].userTheme, true);
  assert.equal(a.events[0].readBack.colorTheme, 'Solarized Light', 'the read back reports what VS Code holds');
  assert.match(a.logs[0], /kept Solarized Light/);
  // The dashboard goes light: the palette moves to Light Modern, the pick stays.
  const b = await applyWith(fake, vsOf(LIGHT));
  assert.equal(b.owned, false);
  assert.equal(fake.store['workbench.colorTheme'], 'Solarized Light');
  assert.deepEqual(Object.keys(fake.store['workbench.colorCustomizations']), ['[Light Modern]']);
  assert.deepEqual(fake.writes.map((w) => w[0]), ['workbench.colorCustomizations']);
});

test('applyTheme: Kiro Crew\'s own theme follows the dashboard from dark to light', async () => {
  const fake = fakeVscode();
  await applyWith(fake, vsOf(DARK));
  const a = await applyWith(fake, vsOf(LIGHT));
  assert.equal(a.owned, true);
  assert.equal(a.changed, true);
  assert.equal(fake.store['workbench.colorTheme'], 'Light Modern');
  assert.deepEqual(Object.keys(fake.store['workbench.colorCustomizations']), ['[Light Modern]']);
});

test('applyTheme: a reset theme setting is Kiro Crew\'s to set again', async () => {
  const fake = fakeVscode();
  await applyWith(fake, vsOf(DARK));
  fake.store['workbench.colorTheme'] = 'Monokai';
  assert.equal((await applyWith(fake, vsOf(DARK))).owned, false);
  delete fake.store['workbench.colorTheme'];
  const a = await applyWith(fake, vsOf(DARK));
  assert.equal(a.owned, true);
  assert.equal(fake.store['workbench.colorTheme'], 'Dark Modern');
});

test('applyTheme: a flat palette from an earlier build is replaced by the scoped one', async () => {
  const flat = { 'editor.background': '#111111', 'statusBar.background': '#222222' };
  const owned = fakeVscode({ user: { 'workbench.colorTheme': 'Dark Modern', 'workbench.colorCustomizations': flat } });
  const a = await applyWith(owned, vsOf(DARK));
  assert.equal(a.owned, true);
  assert.deepEqual(Object.keys(owned.store['workbench.colorCustomizations']), ['[Dark Modern]']);
  const picked = fakeVscode({ user: { 'workbench.colorTheme': 'Monokai', 'workbench.colorCustomizations': flat } });
  const b = await applyWith(picked, vsOf(DARK));
  assert.equal(b.owned, false);
  assert.equal(picked.store['workbench.colorTheme'], 'Monokai');
  assert.deepEqual(Object.keys(picked.store['workbench.colorCustomizations']), ['[Dark Modern]'], 'the flat palette no longer tints the pick');
});

test('applyTheme: a build that names the stock themes "Default ..." gets that name for the theme and the scope', async () => {
  const fake = fakeVscode({ ids: ['Default Dark Modern', 'Default Light Modern'] });
  const a = await applyWith(fake, vsOf(DARK));
  assert.equal(fake.store['workbench.colorTheme'], 'Default Dark Modern');
  assert.deepEqual(Object.keys(fake.store['workbench.colorCustomizations']), ['[Default Dark Modern]']);
  assert.equal(a.events[0].readBack.count > 100, true);
  const b = await applyWith(fake, vsOf(DARK));
  assert.equal(b.changed, false, 'the same theme under its older name is not a change');
});

test('applyTheme: a bad payload is refused, and a failed write is reported and rethrown', async () => {
  const fake = fakeVscode();
  await assert.rejects(() => kcTheme.applyTheme({ vscode: fake.vscode, payload: { colorTheme: 'Dark Modern' }, postEvent: async () => {}, log() {} }), /bad theme payload/);
  const failing = fakeVscode({ failOn: 'workbench.colorCustomizations' });
  const events = [];
  await assert.rejects(
    () => kcTheme.applyTheme({ vscode: failing.vscode, payload: { ...vsOf(DARK), signature: 's' }, postEvent: async (e) => events.push(e), log() {} }),
    /cannot write workbench.colorCustomizations/,
  );
  assert.deepEqual(events.map((e) => [e.type, e.applied]), [['theme', false]]);
  assert.equal(events[0].error, 'cannot write workbench.colorCustomizations');
});

// ---------------------------------------------------------------- the launcher end to end

function freePort() {
  return new Promise((ok) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });
}

test('launcher: a theme picked in VS Code survives POST /api/theme, and the palette still follows Kiro Crew', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-owner-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'backend', 'launcher.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      VSCODE_PANE_ALLOW_UNSIGNED: '1',
      KIROCREW_PROXY_SECRET: '',
      VSCODE_PANE_DATA_DIR: dataDir,
      VSCODE_PANE_SERVER_DIR: path.join(dataDir, 'no-server'),
      VSCODE_PANE_NO_DOWNLOAD: '1',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (body) => fetch(`${base}/api/theme`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const file = path.join(dataDir, 'server-data', 'data', 'Machine', 'settings.json');
  const machine = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  try {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal((await post(DARK)).status, 200);
    assert.equal(machine()['workbench.colorTheme'], 'Dark Modern');
    assert.deepEqual(Object.keys(machine()['workbench.colorCustomizations']), ['[Dark Modern]']);
    // The user picks a theme in VS Code, which edits this file in place.
    fs.writeFileSync(file, JSON.stringify({ ...machine(), 'workbench.colorTheme': 'Solarized Light' }, null, 2) + '\n');
    const p = await post(LIGHT);
    assert.equal(p.json.changed, true);
    assert.equal(machine()['workbench.colorTheme'], 'Solarized Light', 'the pick is not replaced');
    assert.deepEqual(Object.keys(machine()['workbench.colorCustomizations']), ['[Light Modern]'], 'the palette follows Kiro Crew');
    // The user resets the setting: Kiro Crew's theme comes back with the next change.
    const reset = machine();
    delete reset['workbench.colorTheme'];
    fs.writeFileSync(file, JSON.stringify(reset, null, 2) + '\n');
    assert.equal((await post(DARK)).json.changed, true);
    assert.equal(machine()['workbench.colorTheme'], 'Dark Modern');
    assert.deepEqual(Object.keys(machine()['workbench.colorCustomizations']), ['[Dark Modern]']);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
