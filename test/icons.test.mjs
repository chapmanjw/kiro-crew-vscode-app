// The icon files app.json names exist, parse, and are the flat theme-coloured
// marks built from ui/icon.svg.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestIconFiles, svgProblems, isPng } from '../scripts/lib/icon-checks.mjs';
import { buildMarks, extractPaths, PALETTE } from '../scripts/lib/icon-marks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
// Line endings normalised: with core.autocrlf a checkout writes CRLF.
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const BLUES = ['#0065A9', '#007ACC', '#1F9CF0'];

test('every icon field app.json names points at a file that parses', () => {
  const files = manifestIconFiles(ROOT);
  assert.deepEqual(files.map((f) => f.field), ['iconPath', 'iconPathDark', 'ui.pages[0].iconUrl', 'ui.pages[0].iconInactiveUrl']);
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

test('the rail icons are flat two-tone marks with no blue, painted from --ico-a/--ico-b', () => {
  for (const rel of ['assets/icon-dark.svg', 'ui/icon-mono.svg', 'ui/icon-idle.svg']) {
    const svg = read(rel);
    for (const c of BLUES) assert.ok(!svg.toUpperCase().includes(c), `${rel} has ${c}`);
    assert.doesNotMatch(svg, /Gradient|filter|mix-blend|<mask/, `${rel} must be flat`);
    assert.match(svg, /\.a\{fill:var\(--ico-a,#[0-9A-F]{6}\)\}/, rel);
    assert.match(svg, /\.b\{fill:var\(--ico-b,#[0-9A-F]{6}\)\}/, rel);
  }
  // Light/dark halves follow the dashboard's color-scheme; the dark-only file has none.
  assert.match(read('ui/icon-idle.svg'), /@media \(prefers-color-scheme:dark\)/);
  assert.match(read('ui/icon-mono.svg'), /@media \(prefers-color-scheme:dark\)/);
  assert.doesNotMatch(read('assets/icon-dark.svg'), /@media/);
});

test('the flat marks are what scripts/render-icon.mjs builds from ui/icon.svg (same shape, current palette)', () => {
  const src = read('ui/icon.svg');
  const { silhouette, panel } = extractPaths(src);
  const marks = buildMarks(src, PALETTE);
  assert.equal(read('ui/icon-idle.svg'), marks.idle);
  assert.equal(read('ui/icon-mono.svg'), marks.lit);
  assert.equal(read('assets/icon-dark.svg'), marks.darkLit);
  for (const svg of Object.values(marks)) {
    assert.ok(svg.includes(silhouette) && svg.includes(panel), 'uses the real VS Code paths');
  }
  // Idle = muted structure + accent detail; selected = accent structure + text detail.
  assert.ok(marks.idle.includes(`.a{fill:var(--ico-a,${PALETTE.light.muted})}`));
  assert.ok(marks.idle.includes(`.b{fill:var(--ico-b,${PALETTE.dark.accent})}`));
  assert.ok(marks.darkLit.includes(`.a{fill:var(--ico-a,${PALETTE.dark.accent})}`));
  assert.ok(marks.darkLit.includes(`.b{fill:var(--ico-b,${PALETTE.dark.text})}`));
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
  assert.equal(manifest.contributes.sessionControls[0].icon, 'Package');
});
