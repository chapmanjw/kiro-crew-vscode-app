// Contract tests between the page (ui/vscode-pane-core-*.mjs) and the launcher
// (backend/lib/theme.mjs): the theme body the page builds must be one the
// launcher accepts as a full palette, not one it drops to tier "base".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { THEME_KEYS, MAX_THEME_BYTES, resolveTheme, toVsCodeTheme } from '../backend/lib/theme.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreFile = fs.readdirSync(path.join(ROOT, 'ui')).find((f) => /^vscode-pane-core-.*\.mjs$/.test(f));
const { THEME_VARS, buildThemePayload } = await import(pathToFileURL(path.join(ROOT, 'ui', coreFile)).href);

// The stand-in dashboard's Dracula-style palette (scripts/lib/dashboard-standin.mjs),
// as getComputedStyle returns it: hex, rgba() and color-mix() values.
const DRACULA_RAW = {
  '--bg': '#21222c', '--bg-accent': '#232530', '--bg-elevated': '#282a36', '--bg-hover': '#343746',
  '--card': '#262833', '--card-fg': '#f8f8f2', '--panel': '#21222c', '--panel-strong': '#282a36',
  '--text': '#f8f8f2', '--text-strong': '#ffffff', '--muted': '#a3a6c4', '--muted-strong': '#6272a4',
  '--border': '#3a3d4e', '--border-strong': '#4d5066', '--border-hover': '#6272a4',
  '--accent': '#bd93f9', '--accent-fg': '#000', '--accent-hover': '#caa9fa', '--accent-subtle': 'rgba(189, 147, 249, 0.2)', '--ring': '#bd93f9',
  '--ok': '#50fa7b', '--warn': '#f1fa8c', '--danger': '#ff5555', '--info': '#8be9fd',
  '--diff-add': 'rgba(80, 250, 123, 0.15)', '--diff-add-text': '#50fa7b', '--diff-del': 'rgba(255, 85, 85, 0.15)', '--diff-del-text': '#ff5555',
  '--search-highlight': 'color(srgb 1 0.721569 0.423529 / 0.45)',
};

test('every token the page sends is one the launcher accepts', () => {
  const missing = THEME_VARS.filter((k) => !THEME_KEYS.includes(k));
  assert.deepEqual(missing, []);
});

test("the page's full dark palette resolves to tier palette within the size cap", () => {
  const payload = buildThemePayload(DRACULA_RAW, 'dracula-dark', { sdkMode: 'dark', prefersDark: true });
  assert.equal(payload.kind, 'dark');
  assert.ok(Object.keys(payload.vars).length >= 25, `${Object.keys(payload.vars).length} vars`);
  const text = JSON.stringify(payload);
  assert.ok(Buffer.byteLength(text) < MAX_THEME_BYTES, `${Buffer.byteLength(text)} bytes`);
  const r = resolveTheme(payload, Buffer.byteLength(text));
  assert.equal(r.error, undefined);
  assert.equal(r.theme.tier, 'palette', r.theme.reason);
  const vs = toVsCodeTheme(r.theme);
  assert.equal(vs.colorTheme, 'Dark Modern');
  assert.ok(Object.keys(vs.colorCustomizations).length > 0);
});

test("the page's kind-only fallback resolves to tier base", () => {
  const r = resolveTheme({ kind: 'light' });
  assert.equal(r.theme.tier, 'base');
  assert.equal(toVsCodeTheme(r.theme).colorTheme, 'Light Modern');
});
