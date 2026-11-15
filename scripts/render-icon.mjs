#!/usr/bin/env node
// Build every icon file from ui/icon.svg (the VS Code product icon copied from
// an installed VS Code, resources/app/out/media/code-icon.svg), then render a
// preview sheet with a local headless Chrome/Edge
// (playwright-core from .cache/smoke-deps, or from the `smokeDepsRoot` named in
// dev-config.json).
//
//   node scripts/render-icon.mjs            SVGs and .cache/icons/preview.png
//   node scripts/render-icon.mjs --svg-only the SVGs only (no browser)
//
// Outputs:
//   assets/icon-flat.svg flat mark, selected colours (manifest iconPath: store
//                        tile and the rail's selected row)
//   ui/icon-mono.svg     the same file for ui.pages[0].iconUrl
//   ui/icon-idle.svg     flat mark, idle colours (ui.pages[0].iconInactiveUrl)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, findBrowser } from './lib/browser.mjs';
import { buildMarks } from './lib/icon-marks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svgOnly = process.argv.includes('--svg-only');

const source = fs.readFileSync(path.join(ROOT, 'ui', 'icon.svg'), 'utf8');
const marks = buildMarks(source);
const outputs = {
  'assets/icon-flat.svg': marks.lit,
  'ui/icon-mono.svg': marks.lit,
  'ui/icon-idle.svg': marks.idle,
};
for (const [rel, text] of Object.entries(outputs)) {
  fs.writeFileSync(path.join(ROOT, rel), text);
  console.log(`wrote ${rel} (${text.length} bytes)`);
}
if (svgOnly) process.exit(0);

let depsRoot = ROOT;
try {
  const dev = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev-config.json'), 'utf8'));
  if (dev && typeof dev.smokeDepsRoot === 'string') depsRoot = dev.smokeDepsRoot;
} catch {
  /* no dev-config.json */
}
const exe = findBrowser();
if (!exe) throw new Error('no local Chrome/Edge');
const pw = await loadPlaywright(depsRoot);
const browser = await pw.chromium.launch({ executablePath: exe, headless: true });

// Preview sheet: four themes (John's Dracula Pro and Kiro Crew's default, each
// dark and light). Each panel sets the root color-scheme the way Kiro Crew does
// per mode and emulates the matching OS preference, and draws the rail as Kiro
// Crew does: the files go in as <img>, the idle row at opacity-70 in the row's
// muted text colour, the selected row at full opacity. A lucide Package glyph
// (what an installed app with no art gets, painted in currentColor) sits beside
// each for comparison.
const THEMES = [
  { name: 'Dracula Pro, dark', mode: 'dark', panel: '#1A1826', text: '#F8F8F2', muted: '#9C93C9', accent: '#B9A9FF', subtle: '#9580FF26' },
  { name: 'Dracula Pro, light', mode: 'light', panel: '#F5F5F5', text: '#2A2A2A', muted: '#565289', accent: '#644AC9', subtle: '#644AC91F' },
  // website/src/styles/design-tokens.css, the default (emerald) theme.
  { name: 'Kiro Crew default, dark', mode: 'dark', panel: '#12141A', text: '#E4E4E7', muted: '#909098', accent: '#00D492', subtle: 'rgba(4,117,88,.2)' },
  { name: 'Kiro Crew default, light', mode: 'light', panel: '#FAFAFA', text: '#3F3F46', muted: '#6D6D75', accent: '#047558', subtle: 'rgba(4,117,88,.12)' },
];
// lucide `package`, the rail's fallback glyph (stroke = currentColor).
const PACKAGE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/><path d="m7.5 4.27 9 5.15"/></svg>';
const dataUrl = (bytes, type = 'image/svg+xml') => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
const panelShot = async (t) => {
  const page = await browser.newPage({ viewport: { width: 330, height: 170 }, colorScheme: t.mode });
  const row = (label, src, active) => `<div class="row ${active ? 'on' : ''}">
    <span class="ic" style="opacity:${active ? 1 : 0.7}"><img class="s" src="${src}"><span class="g">${PACKAGE}</span><img class="b" src="${src}"></span>
    <span>${label}</span></div>`;
  await page.setContent(`<html><head><style>
    html{color-scheme:${t.mode}}
    body{margin:0;padding:14px;background:${t.panel};color:${t.text};font:13px system-ui,sans-serif}
    h2{margin:0 0 10px;font-size:13px}
    .row{display:flex;align-items:center;gap:14px;padding:6px 10px;border-radius:8px;margin-bottom:6px;color:${t.muted}}
    .row.on{background:${t.subtle};color:${t.accent}}
    .ic{display:flex;gap:12px;align-items:center}
    img.s,.g svg{width:20px;height:20px;display:block} img.b{width:44px;height:44px;display:block}
  </style></head><body>
    <h2>${t.name}</h2>
    ${row('Idle: ui/icon-idle.svg', dataUrl(marks.idle), false)}
    ${row('Selected: assets/icon-flat.svg', dataUrl(marks.lit), true)}
  </body></html>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  const shot = await page.screenshot();
  await page.close();
  return dataUrl(shot, 'image/png');
};
const shots = [];
for (const t of THEMES) shots.push(await panelShot(t));
{
  const page = await browser.newPage({ viewport: { width: 660, height: 340 } });
  await page.setContent(`<html><body style="margin:0;display:grid;grid-template-columns:330px 330px">${shots.map((s) => `<img src="${s}">`).join('')}</body></html>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  const out = path.join(ROOT, '.cache', 'icons', 'preview.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  await page.close();
  console.log('wrote .cache/icons/preview.png');
}
await browser.close();
