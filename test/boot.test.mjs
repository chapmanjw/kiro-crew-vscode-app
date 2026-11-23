// First paint: every layer is the Kiro Crew colour before VS Code or the
// dashboard has painted (backend/lib/theme.mjs bootColors/bootCss,
// frameproxy.mjs injectBootStyle/notReadyHtml, extension crewview.js, the
// pane's iframe host in ui/vscode-pane-*.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootColors, bootCss, resolveTheme, toVsCodeTheme, WEBVIEW_FRAME_CSS } from '../backend/lib/theme.mjs';
import { injectBootStyle, notReadyHtml } from '../backend/lib/frameproxy.mjs';
import { tunnelCss } from '../backend/lib/chipcss.mjs';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { crewViewHtml } = require('../extension/kiro-crew-bridge/crewview.js');

const DRACULA = { kind: 'dark', vars: { '--bg': '#282a36', '--text': '#f8f8f2', '--accent': '#bd93f9' } };

test('bootColors: palette tier uses the workbench editor colour, no theme uses the stock base', () => {
  const t = resolveTheme(DRACULA).theme;
  const vs = toVsCodeTheme(t);
  const c = bootColors(t, vs);
  assert.equal(c.kind, 'dark');
  assert.match(c.bg, /^#[0-9a-f]{6}$/);
  assert.equal(c.bg, String(vs.colorCustomizations['editor.background']).slice(0, 7));
  assert.deepEqual(bootColors(null), { kind: 'dark', bg: '#1f1f1f', fg: '#cccccc' });
  assert.deepEqual(bootColors({ kind: 'light', vars: null }), { kind: 'light', bg: '#ffffff', fg: '#3b3b3b' });
  // An 8-digit colour loses its alpha: a boot colour is always opaque.
  assert.equal(bootColors({ kind: 'dark', vars: { '--bg': '#11223344' } }).bg, '#112233');
});

test('bootCss: zero-specificity rule, scheme only when asked', () => {
  const t = resolveTheme(DRACULA).theme;
  const withScheme = bootCss(t, toVsCodeTheme(t));
  assert.match(withScheme, /^:where\(html\)\{background:#[0-9a-f]{6};color:#[0-9a-f]{6};color-scheme:dark\}:where\(body\)\{background:#[0-9a-f]{6}\}:where\(iframe\.webview\)\{color-scheme:normal\}$/);
  const noScheme = bootCss(t, null, { scheme: false });
  assert.doesNotMatch(noScheme, /color-scheme/);
  assert.match(noScheme, /^:where\(html\)\{background:#282a36;color:#f8f8f2\}/);
});

test('bootCss: the workbench\'s webview frames go back to the normal scheme, and no other page\'s frames are touched', () => {
  // The workbench is in the theme's scheme, and a webview page sets none. A frame whose scheme differs from the
  // one it sits in gets an opaque white canvas, which left the theme's light text on white in the Markdown
  // preview and in an extension's page.
  assert.equal(WEBVIEW_FRAME_CSS, ':where(iframe.webview){color-scheme:normal}');
  const dark = bootCss(resolveTheme(DRACULA).theme, null);
  assert.ok(dark.endsWith(WEBVIEW_FRAME_CSS));
  assert.match(dark, /color-scheme:dark\}/, 'the page itself stays in the theme\'s scheme');
  const light = bootCss(resolveTheme({ kind: 'light' }).theme, null);
  assert.match(light, /color-scheme:light\}.*:where\(iframe\.webview\)\{color-scheme:normal\}$/, 'a light workbench gets the same rule');
  // The tunnelled dashboard sets its own scheme and gets only the colours; its frames are not webviews.
  assert.doesNotMatch(bootCss(resolveTheme(DRACULA).theme, null, { scheme: false }), /iframe/);
  // Zero specificity, no markup: it goes first in the workbench page's head like the rest of the rule.
  assert.match(WEBVIEW_FRAME_CSS, /^:where\(/);
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>';
  assert.ok(injectBootStyle(html, dark).includes(WEBVIEW_FRAME_CSS));
});

test('injectBootStyle puts the rule first in <head>, and refuses markup in the css', () => {
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="x.css"></head><body></body></html>';
  const out = injectBootStyle(html, ':where(html){background:#000000}');
  assert.ok(out.indexOf('<style id="vscp-boot">') < out.indexOf('<meta charset'));
  assert.ok(out.indexOf('<style id="vscp-boot">') < out.indexOf('<link'));
  assert.equal(injectBootStyle('<html><body></body></html>', 'a{}'), null);
  assert.throws(() => injectBootStyle(html, '</style><script>'), /unsafe/);
  assert.ok(injectBootStyle('<html><head lang="en"><title>x</title></head></html>', 'a{}').includes('<head lang="en"><style'));
});

test('the "VS Code is starting" page is themed, not a fixed grey', () => {
  const page = notReadyHtml({ kind: 'light', bg: '#fbf7ef', fg: '#2b2620' });
  assert.match(page, /background:#fbf7ef/);
  assert.match(page, /color-scheme:light/);
});

test('the tunnel stylesheet carries the boot rule after the chip and embed rules', () => {
  const boot = ':where(html){background:#282a36}';
  const css = tunnelCss(boot);
  assert.ok(css.endsWith(boot));
  assert.equal(tunnelCss(), tunnelCss(''));
});

test('the Kiro Crew tab webview hides its frame until the page has loaded, over the side bar colour', () => {
  const nonce = 'abc123';
  const html = crewViewHtml({ available: true, connected: true, slot: 's1', origin: `http://${'a'.repeat(32)}.localhost:5000` }, nonce);
  assert.match(html, /iframe\{[^}]*background:var\(--vscode-sideBar-background\)/);
  assert.match(html, /iframe:not\(\[data-loaded\]\)\{opacity:0\}/);
  assert.match(html, new RegExp(`<script nonce="${nonce}">[^<]*addEventListener\\('load'`));
});

test('the pane keeps the frame hidden over a themed host until load, and passes the scheme on', () => {
  const page = fs.readFileSync(path.join(ROOT, 'ui', 'vscode-pane-0.7.1.mjs'), 'utf8');
  assert.match(page, /\.vscp-frame-host\{background:var\(--vscp-bg\);color-scheme:dark\}/);
  assert.match(page, /\.vscp-frame-host\[data-vscp-kind="light"\]\{color-scheme:light\}/);
  assert.match(page, /\.vscp-frame-host iframe\[data-ready="false"\]\{opacity:0\}/);
  assert.match(page, /iframe\.setAttribute\('data-ready', 'false'\)/);
  assert.match(page, /f\.iframe\.setAttribute\('data-ready', 'false'\);\n  f\.iframe\.src = url;/);
});

test('the launcher wires the boot rule into the workbench proxy and the tunnel', () => {
  const launcher = fs.readFileSync(path.join(ROOT, 'backend', 'launcher.mjs'), 'utf8');
  assert.match(launcher, /boot: \(\) => \(\{ css: bootCss\(theme, vsTheme\), colors: bootColors\(theme, vsTheme\) \}\)/);
});
