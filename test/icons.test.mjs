// The icon files app.json names exist, parse, and are the flat neutral marks
// built from ui/icon.svg, so Kiro Crew's rail never shows the blue mark.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestIconFiles, svgProblems, isPng } from '../scripts/lib/icon-checks.mjs';
import { buildMarks, extractPaths, NEUTRAL } from '../scripts/lib/icon-marks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
// Line endings normalised: with core.autocrlf a checkout writes CRLF.
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const BLUES = ['#0065A9', '#007ACC', '#1F9CF0'];
// Dracula Pro's own colours: the marks must not be tied to one theme.
const DRACULA = ['#B9A9FF', '#9C93C9', '#644AC9', '#565289', '#F8F8F2', '#2A2A2A', '#9580FF'];
const SHIPPED = ['assets/icon-flat.svg', 'ui/icon-mono.svg', 'ui/icon-idle.svg'];

test('every icon field app.json names points at a file that parses', () => {
  const files = manifestIconFiles(ROOT);
  assert.deepEqual(files.map((f) => f.field), ['iconPath', 'ui.pages[0].iconUrl', 'ui.pages[0].iconInactiveUrl']);
  for (const { field, file } of files) {
    assert.ok(fs.existsSync(file), `${field}: ${file} missing`);
    const buf = fs.readFileSync(file);
    if (file.endsWith('.png')) assert.ok(isPng(buf), `${field} is not a PNG`);
    else {
      assert.ok(file.endsWith('.svg'), `${field} is neither .png nor .svg`);
      assert.deepEqual(svgProblems(buf.toString('utf8')), [], field);
    }
  }
});

test('the rail can never pick the blue mark: every manifest icon is a flat SVG', () => {
  assert.equal(manifest.iconPath, 'assets/icon-flat.svg');
  assert.ok(!('iconPathDark' in manifest) && !('iconUrl' in manifest) && !('iconUrlDark' in manifest));
  for (const { field, file } of manifestIconFiles(ROOT)) {
    assert.ok(file.endsWith('.svg'), `${field} must be an SVG`);
    assert.ok(SHIPPED.includes(path.relative(ROOT, file).replace(/\\/g, '/')), `${field} must be a flat mark`);
  }
});

test('the flat marks: no blue, no Dracula colours, neutral greys, --ico tokens, light/dark by color scheme', () => {
  for (const rel of SHIPPED) {
    const svg = read(rel).toUpperCase();
    for (const c of [...BLUES, ...DRACULA]) assert.ok(!svg.includes(c), `${rel} has ${c}`);
    assert.doesNotMatch(svg, /GRADIENT|FILTER|MIX-BLEND|<MASK/, `${rel} must be flat`);
    // Every literal colour is a near-neutral grey (channel spread <= 0x18).
    for (const [, hex] of svg.matchAll(/#([0-9A-F]{6})\b/g)) {
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 0x18, `${rel}: #${hex} is not neutral`);
    }
    const raw = read(rel);
    assert.match(raw, /fill="var\(--ico-a,#[0-9A-F]{6}\)"/, rel);
    assert.match(raw, /fill="var\(--ico-b,#[0-9A-F]{6}\)"/, rel);
    assert.match(raw, /@media \(prefers-color-scheme:dark\)/, rel);
  }
});

test('the flat marks are what scripts/render-icon.mjs builds from ui/icon.svg', () => {
  const src = read('ui/icon.svg');
  const { silhouette, panel } = extractPaths(src);
  const marks = buildMarks(src);
  assert.equal(read('ui/icon-idle.svg'), marks.idle);
  assert.equal(read('ui/icon-mono.svg'), marks.lit);
  assert.equal(read('assets/icon-flat.svg'), marks.lit);
  for (const svg of Object.values(marks)) {
    assert.ok(svg.includes(silhouette) && svg.includes(panel), 'uses the real VS Code paths');
  }
  // Idle is the quieter pair, selected the text-strength pair.
  assert.ok(marks.idle.includes(`.a{fill:var(--ico-a,${NEUTRAL.idle.light.a})}`));
  assert.ok(marks.idle.includes(`.a{fill:var(--ico-a,${NEUTRAL.idle.dark.a})}`));
  assert.ok(marks.lit.includes(`.b{fill:var(--ico-b,${NEUTRAL.lit.dark.b})}`));
  assert.ok(marks.lit.includes(`.b{fill:var(--ico-b,${NEUTRAL.lit.light.b})}`));
});

test('the bridge extension ships the Kiro Crew mark: a PNG icon >= 128px and a currentColor container SVG', () => {
  const ext = path.join(ROOT, 'extension', 'kiro-crew-bridge');
  const pkg = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
  assert.equal(pkg.icon, 'icon.png');
  const png = fs.readFileSync(path.join(ext, pkg.icon));
  assert.ok(isPng(png), 'icon.png is a PNG');
  // IHDR: width and height are the big-endian words at bytes 16 and 20.
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  assert.ok(w >= 128 && h >= 128 && w === h, `${w}x${h}`);
  // The participant and session avatars load the same file (extension.js, sessions.js),
  // and the launcher no longer overwrites it with the VS Code mark.
  assert.match(fs.readFileSync(path.join(ext, 'extension.js'), 'utf8'), /joinPath\(context\.extensionUri, 'icon\.png'\)/);
  assert.doesNotMatch(read('backend/launcher.mjs'), /assets', 'icon\.png'/);
  const icons = new Set([
    ...pkg.contributes.viewsContainers.secondarySidebar.map((c) => c.icon),
    ...Object.values(pkg.contributes.views).flat().map((v) => v.icon).filter(Boolean),
  ]);
  assert.deepEqual([...icons], ['media/kiro-crew.svg']);
  const svg = fs.readFileSync(path.join(ext, 'media', 'kiro-crew.svg'), 'utf8');
  assert.deepEqual(svgProblems(svg), []);
  assert.match(svg, /stroke="currentColor"/);
  // Monochrome: currentColor is the only paint.
  const paints = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]).filter((v) => v !== 'none');
  assert.ok(paints.length && paints.every((v) => v === 'currentColor'), JSON.stringify(paints));
});

test('svgProblems rejects broken or scripted SVG', () => {
  assert.deepEqual(svgProblems('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'), []);
  assert.ok(svgProblems('<html></html>').length);
  assert.ok(svgProblems('<svg xmlns="http://www.w3.org/2000/svg"><g></svg>').length);
  assert.ok(svgProblems('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>').length);
  assert.ok(svgProblems('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>').length);
  assert.ok(svgProblems('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://e.example/x.png"/></svg>').length);
});

test('the composer chip keeps a glyph from AppIcon\'s fixed set', () => {
  // ContextShelf renders <AppIcon icon={sc.icon} /> with no iconUrl, so a file cannot be used there.
  assert.equal(manifest.contributes.sessionControls[0].icon, 'Tag');
});
