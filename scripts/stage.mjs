#!/usr/bin/env node
// Export only the files the app needs into a clean folder to install from.
// Kiro Crew's local-path install copies the whole source tree (it skips only
// node_modules, .git, __pycache__, .venv and .kirocrew-deps), so installing
// this repo directly would also copy the ~1 GB .cache folder.
//
//   node scripts/stage.mjs [dest]      default dest: .cache/stage/vscode-pane
//
// When the R1-B probe's server build exists under .cache, the staged copy gets
// a dev-config.json pointing at it so the first start does not download.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.resolve(process.argv[2] || path.join(ROOT, '.cache', 'stage', 'vscode-pane'));
const INCLUDE = ['app.json', 'README.md', 'assets', 'backend', 'extension', 'ui'];

if (dest === ROOT || ROOT.startsWith(dest + path.sep)) throw new Error('refusing to stage over the repo');
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const item of INCLUDE) {
  const src = path.join(ROOT, item);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, item), { recursive: true });
}

const cacheRoot = path.join(ROOT, '.cache', 'serve-web', 'cli-data', 'serve-web');
let serverDir = null;
if (fs.existsSync(cacheRoot)) {
  for (const name of fs.readdirSync(cacheRoot)) {
    const dir = path.join(cacheRoot, name);
    if (fs.existsSync(path.join(dir, 'out', 'server-main.js'))) serverDir = dir;
  }
}
// A git worktree has no .cache of its own; its gitignored dev-config.json
// names the main checkout's build instead.
if (!serverDir) {
  try {
    const dev = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev-config.json'), 'utf8'));
    if (dev && typeof dev.serverDir === 'string' && fs.existsSync(path.join(dev.serverDir, 'out', 'server-main.js'))) serverDir = dev.serverDir;
  } catch {
    /* no dev-config.json */
  }
}
if (serverDir) {
  fs.writeFileSync(path.join(dest, 'dev-config.json'), JSON.stringify({ serverDir }, null, 2) + '\n');
}
console.log(`staged ${INCLUDE.join(', ')} to ${dest}`);
console.log(serverDir ? `dev-config.json -> serverDir ${serverDir}` : 'no cached server build; first start downloads one');
