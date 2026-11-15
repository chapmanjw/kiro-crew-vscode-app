// Load playwright-core from .cache/smoke-deps (installed by scripts/smoke.mjs
// on first run) and find a local Chrome or Edge to drive.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function loadPlaywright(repoRoot) {
  const deps = path.join(repoRoot, '.cache', 'smoke-deps');
  const entry = path.join(deps, 'node_modules', 'playwright-core', 'index.mjs');
  if (!fs.existsSync(entry)) {
    fs.mkdirSync(deps, { recursive: true });
    if (!fs.existsSync(path.join(deps, 'package.json'))) fs.writeFileSync(path.join(deps, 'package.json'), '{"private":true}');
    const r = spawnSync('npm', ['install', 'playwright-core', '--no-audit', '--no-fund'], { cwd: deps, shell: true, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('npm install playwright-core failed');
  }
  return import(pathToFileURL(entry).href);
}

export function findBrowser() {
  const candidates = [
    process.env.SMOKE_BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}
