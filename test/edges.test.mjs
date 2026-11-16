// Where VS Code's workbench meets the pane card (0.5.2): the Modern UI density
// the launcher writes into the server's Machine settings
// (backend/lib/layoutprefs.mjs), and the smoke's edge, seam and PNG helpers
// (scripts/lib/edge-checks.mjs, scripts/lib/png.mjs). The rendered geometry is
// checked in the smoke against the real workbench.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { layoutSettings } from '../backend/lib/layoutprefs.mjs';
import { seedThemeSettings } from '../backend/lib/theme.mjs';
import { edgeProblems, seamCheck } from '../scripts/lib/edge-checks.mjs';
import { decodePng } from '../scripts/lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the launcher writes the compact Modern UI density into the Machine settings with the chat settings', () => {
  assert.deepEqual(layoutSettings(), { 'window.density.layout': 'compact' });
  const launcher = fs.readFileSync(path.join(ROOT, 'backend', 'launcher.mjs'), 'utf8');
  assert.match(launcher, /seedThemeSettings\(withTerminal, vsTheme, \{ \.\.\.chatSettings\(chatPrefs\), \.\.\.layoutSettings\(\) \}\)/);
  // Merged over whatever is there, leaving the user's other keys alone.
  const out = JSON.parse(seedThemeSettings('{"editor.fontSize": 15, "window.density.layout": "default"}', null, layoutSettings()));
  assert.equal(out['window.density.layout'], 'compact');
  assert.equal(out['editor.fontSize'], 15);
});

const part = (l, t, r, b, extra = {}) => ({ l, t, r, b, radius: [0, 0, 0, 0], border: [0, 0, 0, 0], margin: [0, 0, 0, 0], outer: [], hairline: {}, ...extra });
const flush = () => ({
  vw: 1000, vh: 800,
  classes: { modernUI: true, compact: true },
  parts: {
    titlebar: part(0, 0, 1000, 35),
    activitybar: part(0, 35, 48, 778),
    sidebar: part(48, 35, 300, 778),
    editor: part(300, 35, 700, 500),
    panel: part(300, 500, 700, 778),
    auxiliarybar: part(700, 35, 1000, 778),
    statusbar: part(0, 778, 1000, 800),
  },
  leftParts: ['activitybar'], rightParts: ['auxiliarybar'], bottomParts: ['activitybar', 'sidebar', 'panel', 'auxiliarybar'],
  gaps: { left: 0, right: 0, top: 0, auxbarToStatusbar: 0, clusterToStatusbar: 0, statusbar: [0, 0, 0] },
});

test('edgeProblems passes a flush workbench and names every gap, rounded outer corner and outer border', () => {
  assert.deepEqual(edgeProblems(flush()), []);
  // The Modern UI default: a 4px gutter on the outer edges and above the status bar.
  const d = flush();
  d.gaps = { left: 0, right: 4, top: 0, auxbarToStatusbar: 4, clusterToStatusbar: 4, statusbar: [0, 0, 0] };
  d.parts.auxiliarybar.radius = [8, 8, 8, 8];
  d.parts.auxiliarybar.border = [1, 1, 1, 1];
  const p = edgeProblems(d);
  for (const want of ['right gap 4', 'secondary side bar to status bar 4', 'parts to status bar 4', 'auxiliarybar rounded right corner 8', 'auxiliarybar right border 1', 'auxiliarybar rounded bottom corner 8', 'auxiliarybar bottom border 1']) {
    assert.ok(p.includes(want), `${want} in ${JSON.stringify(p)}`);
  }
  const s = flush();
  s.gaps.statusbar = [0, 0, 2];
  assert.ok(edgeProblems(s).some((x) => /status bar edges/.test(x)));
  const l = flush();
  l.parts.activitybar.border = [0, 0, 0, 1];
  assert.deepEqual(edgeProblems(l), ['activitybar left border 1']);
  assert.deepEqual(edgeProblems({ error: 'no workbench' }), ['no workbench']);
  assert.deepEqual(edgeProblems(null), ['no measurement']);
});

/** A fake screenshot: a uniform frame body with an optional 1px line just inside one side. */
function fakeImage(w, h, slot, lineSide) {
  return {
    width: w, height: h,
    px(x, y) {
      const onLine = (lineSide === 'right' && x === slot.right - 1) || (lineSide === 'left' && x === slot.left) ||
        (lineSide === 'bottom' && y === slot.bottom - 1) || (lineSide === 'top' && y === slot.top);
      return onLine ? [90, 90, 110] : [33, 34, 44];
    },
  };
}

test('seamCheck finds a 1px line inside each side of the frame and passes a clean frame', () => {
  const slot = { left: 50, top: 60, right: 650, bottom: 460 };
  const clean = seamCheck(fakeImage(700, 500, slot), 1, slot);
  assert.equal(Object.keys(clean).length, 8);
  assert.ok(Object.values(clean).every((v) => !v.seam && v.of > 0), JSON.stringify(clean));
  for (const side of ['left', 'right', 'top', 'bottom']) {
    const r = seamCheck(fakeImage(700, 500, slot, side), 1, slot);
    const hit = Object.entries(r).filter(([, v]) => v.seam).map(([k]) => k);
    assert.equal(hit.length, 2, `${side}: ${JSON.stringify(r)}`);
    assert.ok(hit.every((k) => k.startsWith(side)), hit.join('; '));
  }
  // Scaled screenshots (device pixel ratio 2) sample the same CSS lines.
  const s2 = { left: 50, top: 60, right: 650, bottom: 460 };
  const img2 = { px: (x) => (x === 1299 ? [90, 90, 110] : [33, 34, 44]) };
  assert.ok(seamCheck(img2, 2, s2)['right, near the bottom-right corner'].seam);
});

function encodePng(w, h, rgba, filter) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    const line = Buffer.alloc(w * 4);
    for (let x = 0; x < w; x++) rgba(x, y).forEach((v, i) => { line[x * 4 + i] = v; });
    const out = Buffer.alloc(w * 4);
    for (let i = 0; i < out.length; i++) {
      const a = i >= 4 ? line[i - 4] : 0;
      out[i] = filter === 1 ? (line[i] - a) & 255 : line[i];
    }
    rows.push(Buffer.from([filter]), out);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

test('decodePng reads 8-bit RGBA with the None and Sub filters', () => {
  const color = (x, y) => [x * 10, y * 20, (x + y) * 5, 255];
  for (const f of [0, 1]) {
    const img = decodePng(encodePng(7, 5, color, f));
    assert.equal(img.width, 7);
    assert.equal(img.height, 5);
    for (const [x, y] of [[0, 0], [6, 4], [3, 2]]) assert.deepEqual(img.px(x, y), color(x, y).slice(0, 3));
  }
  assert.throws(() => decodePng(Buffer.from('not a png at all')));
});
