#!/usr/bin/env node
// Build every icon file the manifest names from ui/icon.svg (the VS Code
// product icon copied from an installed VS Code,
// resources/app/out/media/code-icon.svg), then render the PNG store icon and a
// preview sheet with a local headless Chrome/Edge (playwright-core from
// .cache/smoke-deps, or from the `smokeDepsRoot` named in dev-config.json).
//
//   node scripts/render-icon.mjs            SVGs, assets/icon.png, .cache/icons/preview.png
//   node scripts/render-icon.mjs --svg-only the SVGs only (no browser)
//
// Outputs:
//   assets/icon.png      full-colour store icon (manifest iconPath)
//   assets/icon-dark.svg flat two-tone mark in the dark palette's lit colours
//                        (manifest iconPathDark: the rail's selected row and the
//                        store tile in dark mode)
//   ui/icon-mono.svg     flat two-tone mark, lit colours, light or dark picked by
//                        prefers-color-scheme (ui.pages[0].iconUrl)
//   ui/icon-idle.svg     the same mark in the idle colours (ui.pages[0].iconInactiveUrl)
//
// The flat marks paint with var(--ico-a) / var(--ico-b) and literal fallbacks.
// Kiro Crew shows an installed app's icons as <img>, where no host CSS reaches
// the file, so the fallbacks are what render today; the variables take effect
// only if Kiro Crew starts inlining installed-app SVGs the way AppIcon inlines
// built-ins.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, findBrowser } from './lib/browser.mjs';
import { buildMarks, PALETTE } from './lib/icon-marks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svgOnly = process.argv.includes('--svg-only');

const source = fs.readFileSync(path.join(ROOT, 'ui', 'icon.svg'), 'utf8');
const marks = buildMarks(source, readPalette());
const outputs = {
  'assets/icon-dark.svg': marks.darkLit,
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

// Store icon: the full-colour mark, 464px on a transparent 512px square.
{
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  const sized = source.replace(/^<svg([^>]*?)\swidth="\d+"\sheight="\d+"/, '<svg$1 width="464" height="464"');
  await page.setContent(`<html><body style="margin:0;width:512px;height:512px;background:transparent;display:grid;place-items:center">
<div style="width:464px;height:464px">${sized}</div></body></html>`);
  const out = path.join(ROOT, 'assets', 'icon.png');
  await page.screenshot({ path: out, omitBackground: true });
  await page.close();
  console.log(`wrote assets/icon.png (${fs.statSync(out).size} bytes)`);
}

// Preview sheet. Each half sets the root color-scheme the way Kiro Crew does
// per mode (and emulates the matching OS preference, as Electron's
// nativeTheme.themeSource would), and shows what the rail draws: the files go
// in as <img>, idle rows at the rail's opacity-70.
const dataUrl = (bytes, type = 'image/svg+xml') => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
const pngUrl = dataUrl(fs.readFileSync(path.join(ROOT, 'assets', 'icon.png')), 'image/png');
const half = async (mode) => {
  const p = PALETTE[mode];
  // What AppIcon picks for the lit row: iconPathDark in dark mode, iconPath in light.
  const lit = mode === 'dark' ? dataUrl(marks.darkLit) : pngUrl;
  const page = await browser.newPage({ viewport: { width: 520, height: 230 }, colorScheme: mode });
  const row = (label, src, active, note) => `<div class="row ${active ? 'on' : ''}">
    <span style="opacity:${active ? 1 : 0.7};display:flex;gap:14px;align-items:center"><img class="s" src="${src}"><img class="b" src="${src}"></span>
    <span class="lbl">${label}<small>${note}</small></span></div>`;
  await page.setContent(`<html><head><style>
    html{color-scheme:${mode}}
    body{margin:0;padding:16px;background:${p.panel};color:${p.text};font:13px system-ui,sans-serif}
    h2{margin:0 0 10px;font-size:14px}
    .row{display:flex;align-items:center;gap:14px;padding:6px 10px;border-radius:8px;margin-bottom:6px;color:${p.muted}}
    .row.on{background:${p.accentSubtle};color:${p.accent}}
    img.s{width:20px;height:20px;display:block} img.b{width:44px;height:44px;display:block}
    .lbl{display:flex;flex-direction:column} small{color:${p.muted};font-size:11px}
  </style></head><body>
    <h2>${p.name}</h2>
    ${row('Idle row', dataUrl(marks.idle), false, 'ui/icon-idle.svg (iconInactiveUrl)')}
    ${row('Selected row', lit, true, mode === 'dark' ? 'assets/icon-dark.svg (iconPathDark)' : 'assets/icon.png (iconPath)')}
    ${row('Page iconUrl', dataUrl(marks.lit), true, 'ui/icon-mono.svg (used only without iconPath)')}
  </body></html>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  const shot = await page.screenshot();
  await page.close();
  return dataUrl(shot, 'image/png');
};
const darkShot = await half('dark');
const lightShot = await half('light');
{
  const page = await browser.newPage({ viewport: { width: 1040, height: 230 } });
  await page.setContent(`<html><body style="margin:0;display:flex"><img src="${darkShot}"><img src="${lightShot}"></body></html>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  const out = path.join(ROOT, '.cache', 'icons', 'preview.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  await page.close();
  console.log('wrote .cache/icons/preview.png');
}
await browser.close();

// John's theme (Dracula Pro) when its variables file is on this machine
// (~/Dropbox/Themes/kirocrew-dracula-pro, or ICON_THEME_VARS); otherwise the
// copy of its values in lib/icon-marks.mjs.
function readPalette() {
  const file = process.env.ICON_THEME_VARS || path.join(os.homedir(), 'Dropbox', 'Themes', 'kirocrew-dracula-pro', 'variables.json');
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const mode of ['dark', 'light']) {
      const m = v[mode] || {};
      for (const [k, css] of [['muted', '--muted'], ['accent', '--accent'], ['text', '--text'], ['panel', '--panel'], ['accentSubtle', '--accent-subtle']]) {
        if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(m[css] || '')) PALETTE[mode][k] = m[css].toUpperCase();
      }
    }
  } catch {
    /* not on this machine: keep the built-in copy */
  }
  return PALETTE;
}
