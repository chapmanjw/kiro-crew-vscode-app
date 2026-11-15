#!/usr/bin/env node
// Render ui/icon.svg (the VS Code product icon copied from an installed VS Code,
// resources/app/out/media/code-icon.svg) to the 512x512 store icon
// assets/icon.png on a transparent background, with a local headless
// Chrome/Edge (playwright-core from .cache/smoke-deps, or from the
// `smokeDepsRoot` named in dev-config.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, findBrowser } from './lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let depsRoot = ROOT;
try {
  const dev = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev-config.json'), 'utf8'));
  if (dev && typeof dev.smokeDepsRoot === 'string') depsRoot = dev.smokeDepsRoot;
} catch {
  /* no dev-config.json */
}
const svg = fs.readFileSync(path.join(ROOT, 'ui', 'icon.svg'), 'utf8');
const exe = findBrowser();
if (!exe) throw new Error('no local Chrome/Edge');
const pw = await loadPlaywright(depsRoot);
const browser = await pw.chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
const sized = svg.replace(/^<svg([^>]*?)\swidth="\d+"\sheight="\d+"/, '<svg$1 width="464" height="464"');
await page.setContent(`<html><body style="margin:0;width:512px;height:512px;background:transparent;display:grid;place-items:center">
<div style="width:464px;height:464px">${sized}</div></body></html>`);
const out = path.join(ROOT, 'assets', 'icon.png');
await page.screenshot({ path: out, omitBackground: true });
await browser.close();
console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);
