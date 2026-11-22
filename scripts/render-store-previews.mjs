#!/usr/bin/env node
// Render the store art the way Kiro Crew crops it, into research/P7-previews/.
//   node scripts/render-store-previews.mjs
// Tile at 32/64/128/512 px, a Browse card (16:9, object-cover) and the detail
// banner (25:6, max-height 288px, object-cover, centred) at several widths.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, findBrowser } from './lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'research', 'P7-previews');
fs.mkdirSync(OUT, { recursive: true });
const url = (rel) => `data:image/svg+xml;base64,${fs.readFileSync(path.join(ROOT, rel)).toString('base64')}`;
const icon = url('assets/icon-blue.svg');
const hero = url('assets/store-hero.svg');
const detail = url('assets/store-hero-detail.svg');

const WIDTHS = [520, 800, 1200, 1550, 1920, 2400];
// Banner box: 25:6 capped at 288px tall; object-cover trims top and bottom equally past 1200px.
const visible = (w) => (w <= 1200 ? [0, 288] : [(288 - 345600 / w) / 2, 288 - (288 - 345600 / w) / 2]);

const { chromium } = await loadPlaywright(ROOT);
const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
async function shot(name, html, width, height, scheme = 'light') {
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: scheme });
  await page.setContent(`<html><body style="margin:0;background:#fff;font:14px system-ui,sans-serif">${html}</body></html>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await page.screenshot({ path: path.join(OUT, name) });
  await page.close();
  console.log('wrote', name);
}

// The blue mark is transparent with no colour-scheme rule, so one file is drawn on a light page and a dark page.
const PAGE = { light: '#ffffff', dark: '#19161d' };
for (const size of [32, 64, 128, 512]) for (const s of ['light', 'dark']) {
  await shot(`tile-${size}-${s}.png`, `<div style="padding:16px;background:${PAGE[s]}"><img src="${icon}" style="width:${size}px;height:${size}px;display:block"></div>`, size + 32, size + 32, s);
}
const card = (w, s) => `<div style="width:${w}px;border:1px solid ${s === 'dark' ? '#333' : '#ddd'};border-radius:16px;overflow:hidden;background:${PAGE[s]};color:${s === 'dark' ? '#eee' : '#222'}">
<div style="aspect-ratio:16/9;position:relative;overflow:hidden"><img src="${hero}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></div>
<div style="display:flex;gap:12px;align-items:center;padding:14px"><img src="${icon}" style="width:48px;height:48px"><div><b>Visual Studio Code Server Integration</b><br><span style="opacity:.7">Code, editor, vscode</span></div></div></div>`;
for (const s of ['light', 'dark']) await shot(`store-card-${s}.png`, `<div style="padding:24px;background:${s === 'dark' ? '#0b0c10' : '#f4f4f7'}">${card(420, s)}</div>`, 470, 420, s);
const banner = (w) => `<div style="width:${w}px;aspect-ratio:25/6;max-height:288px;border:1px solid #ccc;border-radius:16px;overflow:hidden;margin-bottom:16px"><img src="${detail}" style="width:100%;height:100%;object-fit:cover;display:block"></div>`;
for (const w of WIDTHS) await shot(`detail-${w}.png`, `<div style="padding:16px">${banner(w)}</div>`, w + 32, Math.min(288, Math.round(w * 0.24)) + 34);

// Contrast of each fill against white, Kiro Crew's dark background and a mid grey (WCAG 2 ratio; 3:1 is the
// non-text threshold). Also a 64px tile on the grey.
const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const contrast = [];
for (const [bn, bg] of [['white', '#ffffff'], ['dark #19161d', '#19161d'], ['mid grey #808080', '#808080']]) {
  contrast.push(bn + ': ' + [['#0065A9', 'upper'], ['#007ACC', 'lower'], ['#1F9CF0', 'panel']].map(([c, n]) => n + ' ' + c + ' ' + ratio(c, bg).toFixed(2) + ':1').join(', '));
}
fs.writeFileSync(path.join(OUT, 'contrast.txt'), contrast.join('\n') + '\n');
console.log(contrast.join('\n'));
await shot('tile-64-grey.png', '<div style="padding:16px;background:#808080"><img src="' + icon + '" style="width:64px;height:64px;display:block"></div>', 96, 96);

// App-page header crop: the tile at the size the detail page shows it, rounded.
await shot('app-header.png', `<div style="display:flex;gap:20px;align-items:center;padding:20px;background:#fff"><img src="${icon}" style="width:96px;height:96px"><div><b style="font-size:22px">Visual Studio Code Server Integration</b><br><span style="opacity:.7">John Chapman</span></div></div>`, 560, 140);

// Safe-area check: every drawn element outside the backdrop must sit inside the band visible at each width.
const report = [];
const page = await browser.newPage({ viewport: { width: 1300, height: 700 } });
for (const [name, rel, w, h] of [['detail', 'assets/store-hero-detail.svg', 1200, 288], ['hero', 'assets/store-hero.svg', 1200, 675]]) {
  await page.setContent(`<body style="margin:0">${fs.readFileSync(path.join(ROOT, rel), 'utf8')}</body>`);
  const r = await page.evaluate(() => {
    const svg = document.querySelector('svg'); const s = svg.getBoundingClientRect(); const k = 1200 / s.width;
    const box = (el) => { const b = el.getBoundingClientRect(); return { x0: (b.left - s.left) * k, y0: (b.top - s.top) * k, x1: (b.right - s.left) * k, y1: (b.bottom - s.top) * k }; };
    const u = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 }; const parts = {};
    for (const el of svg.children) { if (!['g', 'text'].includes(el.tagName) || el.id === 'bg') continue; const b = box(el); parts[el.id] = b; u.x0 = Math.min(u.x0, b.x0); u.y0 = Math.min(u.y0, b.y0); u.x1 = Math.max(u.x1, b.x1); u.y1 = Math.max(u.y1, b.y1); }
    return { u, parts };
  });
  const rd = (n) => Math.round(n * 10) / 10;
  if (name === 'detail') {
    const text = Math.max(r.parts.head1.x1, r.parts.sub1.x1); const art = r.parts.art.x0;
    report.push(`detail content bbox x ${rd(r.u.x0)}..${rd(r.u.x1)}, y ${rd(r.u.y0)}..${rd(r.u.y1)}; text ends ${rd(text)}, window starts ${rd(art)} (gap ${rd(art - text)})`);
    for (const wd of WIDTHS) {
      const [t, b] = visible(wd); const scale = Math.max(wd / 1200, 1);
      const marginTop = r.u.y0 - t; const marginBottom = b - r.u.y1;
      const ok = marginTop >= 6 && marginBottom >= 6 && art - text >= 24;
      report.push(`  ${wd}px: visible y ${rd(t)}..${rd(b)} (${rd(b - t)} units), margin top ${rd(marginTop)} / bottom ${rd(marginBottom)} units = ${rd(marginTop * scale)} / ${rd(marginBottom * scale)} px ${ok ? 'OK' : 'FAIL'}`);
      if (!ok) process.exitCode = 1;
    }
  } else {
    report.push(`hero (16:9, never cropped) content bbox x ${rd(r.u.x0)}..${rd(r.u.x1)}, y ${rd(r.u.y0)}..${rd(r.u.y1)} of 1200x675; text ends ${rd(Math.max(...['head1', 'head2', 'sub1', 'sub2'].map((i) => r.parts[i].x1)))}, window starts ${rd(r.parts.art.x0)}`);
    if (r.u.x0 < 40 || r.u.y0 < 40 || r.u.x1 > 1160 || r.u.y1 > 635) process.exitCode = 1;
  }
}
fs.writeFileSync(path.join(OUT, 'safe-area.txt'), report.join('\n') + '\n');
console.log(report.join('\n'));
await browser.close();
