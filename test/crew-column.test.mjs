// Unit tests for the docked Kiro Crew chat column: its pure helpers
// (ui/vscode-pane-crew-core-*.mjs) and how the page and column are wired to
// the SDK's ChatPanel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const pick = (re) => fs.readdirSync(UI).find((f) => re.test(f));
const crewCoreFile = pick(/^vscode-pane-crew-core-.*\.mjs$/);
const crewFile = pick(/^vscode-pane-crew-\d.*\.mjs$/);
const core = await import(pathToFileURL(path.join(UI, crewCoreFile)).href);
const pageSrc = fs.readFileSync(path.join(UI, manifest.ui.entry), 'utf8');
const crewSrc = fs.readFileSync(path.join(UI, crewFile), 'utf8');
const {
  CREW_WIDTH, CREW_HEADER_HEIGHT, STORE_KEYS, clampCrewWidth, parseStoredWidth, parseStoredOpen, normFolder, folderBase, mainSlotTitle,
  crewSlotFromSession, toggleCounter, counterStep, crewSessionsForFolder, chatPageHref, frameRadii,
} = core;

test('column files carry the same version as the page entry', () => {
  const v = /-(\d+\.\d+\.\d+)\.mjs$/.exec(manifest.ui.entry)[1];
  assert.equal(crewCoreFile, `vscode-pane-crew-core-${v}.mjs`);
  assert.equal(crewFile, `vscode-pane-crew-${v}.mjs`);
});

test('geometry: 420 default, 360 minimum, 35px header like VS Code side-bar titles', () => {
  assert.equal(CREW_WIDTH.default, 420);
  assert.equal(CREW_WIDTH.min, 360);
  assert.equal(CREW_HEADER_HEIGHT, 35);
});

test('clampCrewWidth keeps the column at its minimum and VS Code at 320px plus the sash', () => {
  assert.equal(clampCrewWidth(500, 1400), 500);
  assert.equal(clampCrewWidth(100, 1400), 360);
  assert.equal(clampCrewWidth(1300, 1400), 1400 - 320 - 4);
  assert.equal(clampCrewWidth(500, 600), 360, 'a card too narrow for both still gives the column its minimum');
  assert.equal(clampCrewWidth(NaN, 1400), 420);
  assert.equal(clampCrewWidth(480.6, Infinity), 481);
  assert.equal(clampCrewWidth(480, 0), 480, 'an unmeasured card does not cap the width');
});

test('stored width and open state parse defensively', () => {
  assert.equal(parseStoredWidth('512'), 512);
  for (const bad of [null, undefined, '', 'abc', '12', '99999']) assert.equal(parseStoredWidth(bad), 420, String(bad));
  assert.equal(parseStoredOpen(null), true, 'open by default');
  assert.equal(parseStoredOpen('1'), true);
  assert.equal(parseStoredOpen('0'), false);
  assert.deepEqual(Object.values(STORE_KEYS).sort(), ['kc:vscode-pane:crew-open', 'kc:vscode-pane:crew-slot', 'kc:vscode-pane:crew-width']);
});

test('folder helpers normalise like the launcher', () => {
  assert.equal(normFolder('C:\\Users\\Me\\Proj\\'), 'c:/users/me/proj');
  assert.equal(normFolder('/home/Me/proj/', 'linux'), '/home/Me/proj');
  assert.equal(folderBase('C:\\a\\b\\kiro-crew-vscode-app\\'), 'kiro-crew-vscode-app');
  assert.equal(mainSlotTitle('C:\\a\\kiro-crew-vscode-app'), 'VS Code: kiro-crew-vscode-app');
  assert.equal(mainSlotTitle(''), 'VS Code: workspace');
});

test('crewSlotFromSession reads crewSlot, then crewSlotKey, then chatSlot', () => {
  assert.equal(crewSlotFromSession(null), null);
  assert.equal(crewSlotFromSession({}), null);
  assert.deepEqual(crewSlotFromSession({ folder: 'F', crewSlot: { key: 'k1', title: 'VS Code: F' } }), { key: 'k1', folder: 'F', title: 'VS Code: F' });
  assert.deepEqual(crewSlotFromSession({ folder: 'F', crewSlot: { key: 'k1', folder: 'G' } }), { key: 'k1', folder: 'G', title: '' });
  assert.deepEqual(crewSlotFromSession({ folder: 'F', crewSlot: 'k2' }), { key: 'k2', folder: 'F', title: '' });
  assert.deepEqual(crewSlotFromSession({ folder: 'F', crewSlotKey: 'k3' }), { key: 'k3', folder: 'F', title: '' });
  assert.deepEqual(crewSlotFromSession({ folder: 'F', chatSlot: { key: 'k4' } }), { key: 'k4', folder: 'F', title: '' });
  assert.equal(crewSlotFromSession({ crewSlot: { key: '  ' } }), null);
  assert.equal(crewSlotFromSession({ chatSlot: { code: 'permission' } }), null, 'a chat-slot error has no key');
});

test('toggleCounter accepts only a non-negative integer', () => {
  assert.equal(toggleCounter({ crewChatToggle: 3 }), 3);
  assert.equal(toggleCounter({ crewChatToggle: 0 }), 0);
  for (const bad of [undefined, null, -1, 1.5, '2']) assert.equal(toggleCounter({ crewChatToggle: bad }), null, String(bad));
  assert.equal(toggleCounter(null), null);
});

test('counterStep: first reading is a baseline, odd presses toggle, a new run rebases', () => {
  let r = counterStep(null, 'run1', 4);
  assert.equal(r.toggle, false, 'opening the page does not replay old presses');
  assert.deepEqual(r.seen, { instance: 'run1', count: 4 });
  r = counterStep(r.seen, 'run1', 4);
  assert.equal(r.toggle, false);
  r = counterStep(r.seen, 'run1', 5);
  assert.equal(r.toggle, true);
  r = counterStep(r.seen, 'run1', 7);
  assert.equal(r.toggle, false, 'two presses between polls cancel out');
  assert.equal(r.presses, 2);
  r = counterStep(r.seen, 'run1', 10);
  assert.equal(r.toggle, true, 'three presses toggle once');
  r = counterStep(r.seen, 'run2', 1);
  assert.equal(r.toggle, false, 'a restarted launcher is a new baseline');
  r = counterStep({ instance: 'run2', count: 5 }, 'run2', 0);
  assert.equal(r.toggle, false, 'a counter that went down is a new baseline');
  r = counterStep(r.seen, 'run2', null);
  assert.equal(r.toggle, false);
  assert.deepEqual(r.seen, { instance: 'run2', count: 0 }, 'no reading keeps the last one');
});

test('crewSessionsForFolder lists this folder\'s sessions, main first, then most recent', () => {
  const folder = 'C:\\Work\\App';
  const slots = [
    { key: 'other', title: 'Elsewhere', project: 'C:\\Other' },
    { key: 'old', title: 'Old chat', project: 'c:/work/app/', last_ts: '2026-11-01T00:00:00Z' },
    { key: 'new', title: 'New chat', project: 'C:\\Work\\App', last_ts: '2026-11-15T00:00:00Z', running: true },
    { key: 'ws', title: 'By workspace', workspace: 'C:\\Work\\App', created: '2026-11-10T00:00:00Z' },
    { key: 'main', title: 'VS Code: App', project: 'C:\\Work\\App' },
    { key: 'new', title: 'duplicate', project: 'C:\\Work\\App' },
    { title: 'no key', project: 'C:\\Work\\App' },
    null,
  ];
  const out = crewSessionsForFolder(slots, folder, 'main');
  assert.deepEqual(out.map((s) => s.key), ['main', 'new', 'ws', 'old']);
  assert.equal(out[0].main, true);
  assert.equal(out[1].running, true);
  assert.equal(out[1].title, 'New chat');
});

test('crewSessionsForFolder lists the main slot before the gateway reports it', () => {
  const out = crewSessionsForFolder([], 'C:\\Work\\App', 'vscode-app-0123456789');
  assert.deepEqual(out, [{ key: 'vscode-app-0123456789', title: 'VS Code: App', running: false, last: 0, main: true }]);
  assert.deepEqual(crewSessionsForFolder(undefined, '', ''), []);
  // The main slot is kept even when its project differs (the user re-pointed it).
  assert.deepEqual(crewSessionsForFolder([{ key: 'm', project: 'D:\\x' }], 'C:\\Work\\App', 'm').map((s) => s.key), ['m']);
});

test('chatPageHref and frameRadii', () => {
  assert.equal(chatPageHref('vscode-app-1'), '/chat/vscode-app-1');
  assert.equal(chatPageHref('a b'), '/chat/a%20b');
  assert.equal(chatPageHref(''), '/chat');
  assert.deepEqual(frameRadii(15, false), [0, 0, 15, 15], 'no column: both bottom corners are the frame\'s');
  assert.deepEqual(frameRadii(15, true), [0, 0, 0, 15], 'docked column: only bottom-left');
});

test('the column imports the SDK as a namespace and reads ChatPanel at render time', () => {
  // A named import of an export the host lacks fails the whole page at load
  // (docs/app-kit/api-reference.md, Pull Request Panel), so the column must
  // never name ChatPanel in an import.
  assert.match(crewSrc, /import \* as sdk from '@kirocrew\/app-sdk';/);
  assert.doesNotMatch(crewSrc, /import\s*\{[^}]*ChatPanel[^}]*\}\s*from/);
  assert.doesNotMatch(pageSrc, /import\s*\{[^}]*ChatPanel[^}]*\}\s*from/);
  assert.match(crewSrc, /const Panel = sdk\.ChatPanel;/);
  assert.match(crewSrc, /h\(Panel, \{ key: slotKey, slotKey, conversationOnly: true \}\)/);
  assert.match(crewSrc, /data-testid': 'vscode-pane-crew-fallback'/);
  assert.doesNotMatch(crewSrc, /ChatEmbed/, 'ChatEmbed is not the session pane and is never a fallback');
});

test('the page docks the column beside the frame slot and toggles it', () => {
  assert.match(pageSrc, /from '\.\/vscode-pane-crew-\d+\.\d+\.\d+\.mjs'/);
  assert.match(pageSrc, /className: 'vscp-split'/);
  assert.match(pageSrc, /crewOpen \? h\(CrewColumn,/);
  assert.match(pageSrc, /'data-testid': 'vscode-pane-crew-toggle'/);
  assert.match(pageSrc, /counterStep\(holder\.crewSeen/);
  assert.match(pageSrc, /frameRadii\(inner, crewOpenRef\.current\)/);
});

test('the UI never turns off VS Code\'s own Chat or its secondary side bar', () => {
  for (const f of fs.readdirSync(UI).filter((n) => n.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(UI, f), 'utf8');
    assert.doesNotMatch(src, /chat\.disableAIFeatures|secondarySideBar\.defaultVisibility/, f);
  }
});

test('the column styles use theme variables only (no literal colours outside fallbacks)', () => {
  const css = /const CSS = `([\s\S]*?)`;/.exec(crewSrc)[1];
  // Literal colours may appear only as var() fallbacks or inside color-mix of a shadow.
  const stripped = css.replace(/var\(--[a-z-]+,[^)]*\)/g, 'var()').replace(/color-mix\(in srgb,#000 35%,transparent\)/g, '');
  assert.doesNotMatch(stripped, /#[0-9a-f]{3,8}\b|rgba?\(/i);
});
