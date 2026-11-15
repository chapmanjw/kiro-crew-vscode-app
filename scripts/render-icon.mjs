#!/usr/bin/env node
// Render ui/icon.svg to the opaque 512x512 store icon assets/icon.png with a
// local headless Chrome/Edge (playwright-core from .cache/smoke-deps).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, findBrowser } from './lib/browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(ROOT, 'ui', 'icon.svg'), 'utf8');
const exe = findBrowser();
if (!exe) throw new Error('no local Chrome/Edge');
const pw = await loadPlaywright(ROOT);
const browser = await pw.chromium.launch({ executablePath: exe, headless: true });
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
await page.setContent(`<body style="margin:0;width:512px;height:512px;background:#0d1117;display:grid;place-items:center">
<div style="width:440px;height:440px">${svg.replace('width="64" height="64"', 'width="440" height="440"')}</div></body>`);
const out = path.join(ROOT, 'assets', 'icon.png');
await page.screenshot({ path: out, omitBackground: false });
await browser.close();
console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);
