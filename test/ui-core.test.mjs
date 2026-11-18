// Unit tests for the UI's pure helpers (ui/vscode-pane-core-*.mjs) and the
// manifest wiring the round-2 UI depends on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const coreFile = fs.readdirSync(path.join(ROOT, 'ui')).find((f) => /^vscode-pane-core-.*\.mjs$/.test(f));
const core = await import(pathToFileURL(path.join(ROOT, 'ui', coreFile)).href);
const { parseColor, rgbToHex, blend, themeKind, resolveKind, kindFromName, buildThemePayload, folderFromSearch, appPageUrl, frameKey, framePlacement, THEME_VARS } = core;

test('parseColor reads hex, rgb(), rgba(), space syntax and color(srgb)', () => {
  assert.deepEqual(parseColor('#abc'), { r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
  assert.deepEqual(parseColor('#21222c'), { r: 0x21, g: 0x22, b: 0x2c, a: 1 });
  assert.equal(parseColor('#21222c80').a, 128 / 255);
  assert.deepEqual(parseColor('rgb(1, 2, 3)'), { r: 1, g: 2, b: 3, a: 1 });
  assert.deepEqual(parseColor('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseColor('color(srgb 1 0.5 0 / 0.25)'), { r: 255, g: 128, b: 0, a: 0.25 });
  for (const bad of ['', 'red', 'oklab(0.5 0 0)', '#12', 'rgb(1,2)', null, undefined, 42]) assert.equal(parseColor(bad), null, String(bad));
});

test('rgbToHex clamps and pads', () => {
  assert.equal(rgbToHex({ r: 0, g: 15, b: 255 }), '#000fff');
  assert.equal(rgbToHex({ r: -4, g: 300, b: 127.6 }), '#00ff80');
});

test('blend composites a translucent colour over the background', () => {
  assert.deepEqual(blend({ r: 255, g: 0, b: 0, a: 0.5 }, { r: 0, g: 0, b: 255 }), { r: 128, g: 0, b: 128, a: 1 });
  assert.deepEqual(blend({ r: 9, g: 9, b: 9, a: 1 }, { r: 0, g: 0, b: 0 }), { r: 9, g: 9, b: 9, a: 1 });
});

test('themeKind uses the background luminance, then the palette name', () => {
  assert.equal(themeKind('#21222c'), 'dark');
  assert.equal(themeKind('#fafafa'), 'light');
  assert.equal(themeKind('#7f7f7f'), 'light');
  assert.equal(themeKind('', 'dracula-light'), 'light');
  assert.equal(themeKind(undefined, 'kiro-dark'), 'dark');
});

test('buildThemePayload: opaque hex for every known token, translucent ones composited over --bg', () => {
  const p = buildThemePayload({
    '--bg': 'rgba(33, 34, 44, 1)',
    '--accent': 'rgb(189, 147, 249)',
    '--diff-add': 'rgba(80, 250, 123, 0.15)',
    '--text': '#f8f8f2',
    '--not-a-token': '#ffffff',
    '--border': 'garbage',
  }, 'dracula-dark');
  assert.equal(p.kind, 'dark');
  assert.deepEqual(Object.keys(p.vars).sort(), ['--accent', '--bg', '--diff-add', '--text']);
  assert.equal(p.vars['--bg'], '#21222c');
  assert.equal(p.vars['--accent'], '#bd93f9');
  assert.equal(p.vars['--diff-add'], rgbToHex(blend({ r: 80, g: 250, b: 123, a: 0.15 }, { r: 33, g: 34, b: 44 })));
  for (const v of Object.values(p.vars)) assert.match(v, /^#[0-9a-f]{6}$/);
  const light = buildThemePayload({ '--bg': '#ffffff' }, 'whatever');
  assert.equal(light.kind, 'light');
  // A translucent background is put over white for a light palette, black for a dark one.
  assert.equal(buildThemePayload({ '--bg': 'rgba(0, 0, 0, 0.5)' }, 'x-light').vars['--bg'], '#808080');
  assert.equal(buildThemePayload({ '--bg': 'rgba(255, 255, 255, 0.5)' }, 'x-dark').vars['--bg'], '#808080');
});

test('kindFromName reads the -dark/-light palette suffix and bare names only', () => {
  for (const [n, k] of [['dracula-dark', 'dark'], ['kiro-light', 'light'], ['light', 'light'], ['dark', 'dark'], ['amoled-grey-calm-light', 'light'], ['highcontrast-dark', 'dark']]) assert.equal(kindFromName(n), k, n);
  for (const n of ['', 'my-theme', 'darkness', 'lightyear', 'default', undefined, null]) assert.equal(kindFromName(n), '', String(n));
});

test('resolveKind: data-theme, then useTheme mode, then --bg luminance, then OS scheme, then dark', () => {
  assert.equal(resolveKind({ themeName: 'kiro-light', sdkMode: 'dark', bg: '#000000' }), 'light');
  assert.equal(resolveKind({ themeName: 'custom', sdkMode: 'solarized-light', bg: '#000000' }), 'light');
  assert.equal(resolveKind({ themeName: 'custom', sdkMode: 'custom', bg: '#fdf6e3' }), 'light');
  assert.equal(resolveKind({ themeName: 'custom', bg: '#002b36', prefersDark: false }), 'dark');
  assert.equal(resolveKind({ prefersDark: false }), 'light');
  assert.equal(resolveKind({ prefersDark: true }), 'dark');
  assert.equal(resolveKind({}), 'dark');
  assert.equal(resolveKind(), 'dark');
});

test('buildThemePayload falls back to {kind} alone when no variable could be read', () => {
  assert.deepEqual(buildThemePayload({}, 'kiro-light'), { kind: 'light' });
  assert.deepEqual(buildThemePayload({ '--bg': '', '--text': 'garbage', '--accent': 'oklab(0.5 0 0)' }, 'dracula-dark'), { kind: 'dark' });
  assert.deepEqual(buildThemePayload(null, '', { prefersDark: false }), { kind: 'light' });
  assert.deepEqual(buildThemePayload(undefined, 'my-theme', { sdkMode: 'nord-light' }), { kind: 'light' });
  assert.ok(!('vars' in buildThemePayload({}, '')));
  // With variables, kind still comes from the palette name before the background.
  const p = buildThemePayload({ '--bg': '#ffffff' }, 'odd-dark');
  assert.equal(p.kind, 'dark');
  assert.deepEqual(p.vars, { '--bg': '#ffffff' });
});

test('THEME_VARS covers the tokens VS Code theming needs', () => {
  for (const k of ['--bg', '--bg-elevated', '--panel', '--border', '--text', '--muted', '--accent', '--surface']) assert.ok(THEME_VARS.includes(k), k);
});

test('folderFromSearch and appPageUrl round-trip Windows and POSIX paths', () => {
  for (const f of ['C:\\Users\\me\\My Project', '/home/me/a&b?c#d', 'D:\\x\\%20']) {
    const url = appPageUrl(f);
    assert.ok(url.startsWith('/apps/vscode-pane?folder='), url);
    assert.equal(folderFromSearch(url.slice(url.indexOf('?'))), f);
  }
  assert.equal(appPageUrl(''), '/apps/vscode-pane');
  assert.equal(appPageUrl('   '), '/apps/vscode-pane');
  assert.equal(appPageUrl(undefined), '/apps/vscode-pane');
  assert.equal(folderFromSearch(''), '');
  assert.equal(folderFromSearch('?other=1'), '');
  assert.equal(folderFromSearch('?folder=%20%20'), '');
});

test('frameKey changes only with URL, reload nonce, launcher run or server generation', () => {
  const s = { ready: true, url: 'http://127.0.0.1:1/vsc-k/?folder=/a', generation: 2, instance: 'run1' };
  // A launcher restart with the same URL and generation still reloads the frame.
  assert.notEqual(frameKey(s, 0), frameKey({ ...s, instance: 'run2' }, 0));
  assert.equal(frameKey(s, 0), frameKey({ ...s, status: 'ready', message: 'x' }, 0));
  assert.notEqual(frameKey(s, 0), frameKey(s, 1));
  assert.notEqual(frameKey(s, 0), frameKey({ ...s, generation: 3 }, 0));
  assert.notEqual(frameKey(s, 0), frameKey({ ...s, url: s.url.replace('/a', '/b') }, 0));
  assert.equal(frameKey({ ...s, ready: false }, 0), null);
  assert.equal(frameKey(null, 0), null);
});

test('framePlacement positions over the slot and clips to bounds with rounded bottom corners', () => {
  const bounds = { top: 0, left: 64, width: 1000, height: 800 };
  const p = framePlacement({ top: 50, left: 80, width: 900, height: 700 }, bounds, [0, 0, 15, 15]);
  assert.deepEqual(p, { left: 80, top: 50, width: 900, height: 700, clip: 'inset(0px 0px 0px 0px round 0px 0px 15px 15px)' });
  // Scrolled so the slot's top is above <main>: the overlap is clipped off.
  const q = framePlacement({ top: -20, left: 80, width: 900, height: 700 }, bounds, [0, 0, 15, 15]);
  assert.equal(q.clip, 'inset(20px 0px 0px 0px round 0px 0px 15px 15px)');
  // Extends past the right and bottom of the bounds.
  const r = framePlacement({ top: 100, left: 600, width: 600, height: 800 }, bounds);
  assert.equal(r.clip, 'inset(0px 136px 100px 0px round 0px 0px 0px 0px)');
  assert.equal(framePlacement({ top: 900, left: 80, width: 100, height: 100 }, bounds), null);
  assert.equal(framePlacement({ top: 0, left: 0, width: 0, height: 10 }, bounds), null);
  assert.equal(framePlacement(null, bounds), null);
});

test('manifest: version, bundle names, permissions, icons and the composer control', () => {
  assert.equal(manifest.version, '0.6.3');
  assert.equal(manifest.ui.entry, `vscode-pane-${manifest.version}.mjs`);
  assert.ok(fs.existsSync(path.join(ROOT, 'ui', manifest.ui.entry)));
  assert.equal(coreFile, `vscode-pane-core-${manifest.version}.mjs`);
  for (const p of ['/apps/vscode-pane/api', '/api/recent-projects', '/api/chat', '/api/chat/slots', '/api/status']) assert.ok(manifest.permissions.api.includes(p), p);
  const [ctl, ...rest] = manifest.contributes.sessionControls;
  assert.equal(rest.length, 0);
  assert.match(ctl.id, /^[a-z0-9][a-z0-9-]*$/);
  assert.equal(ctl.entryPoint, `vscode-pane-session-${manifest.version}.mjs`);
  assert.ok(fs.existsSync(path.join(ROOT, 'ui', ctl.entryPoint)));
  // AppIcon's ICON_MAP (website/src/components/AppIcon.tsx); other names fall back to Package.
  assert.ok(['Shield', 'Bot', 'Search', 'Tag', 'Users', 'Zap', 'Star', 'Package', 'Cat', 'AudioLines', 'Mic'].includes(ctl.icon));
  assert.ok(fs.existsSync(path.join(ROOT, manifest.iconPath)));
  assert.ok(fs.existsSync(path.join(ROOT, 'ui', manifest.ui.pages[0].iconUrl)));
  // The source art is the real VS Code mark (Microsoft's blue gradient), not the
  // Code-OSS art; the page icons are flat marks built from it (icons.test.mjs).
  const svg = fs.readFileSync(path.join(ROOT, 'ui', 'icon.svg'), 'utf8');
  for (const c of ['#0065A9', '#007ACC', '#1F9CF0']) assert.ok(svg.includes(c), c);
  // Every UI module the page imports by relative path ships with the same version.
  for (const f of [manifest.ui.entry, ctl.entryPoint]) {
    const src = fs.readFileSync(path.join(ROOT, 'ui', f), 'utf8');
    for (const m of src.matchAll(/from '\.\/([^']+)'/g)) assert.ok(fs.existsSync(path.join(ROOT, 'ui', m[1])), `${f} -> ${m[1]}`);
  }
});

test('describeSessionError names Node.js when the gateway has no backend for the app', () => {
  const down = core.describeSessionError("app 'vscode-pane' has no reachable backend");
  assert.equal(down.backendDown, true);
  assert.match(down.message, /Node\.js/);
  assert.match(down.message, /no node binary found/);
  const other = core.describeSessionError('request failed');
  assert.equal(other.backendDown, false);
  assert.equal(other.message, 'Backend unreachable: request failed');
  assert.equal(core.describeSessionError('').message, '');
});
