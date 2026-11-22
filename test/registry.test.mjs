// The root app-registry.json lets Kiro Crew add this repo as an app source, and
// the store listing, rail label and art come from app.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'app-registry.json'), 'utf8'));

test('app-registry.json is one entry naming this app and its repository', () => {
  assert.ok(Array.isArray(registry) && registry.length === 1);
  const [entry] = registry;
  assert.equal(entry.name, manifest.name);
  assert.match(entry.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'a kebab-case name, as the gateway requires');
  assert.equal(entry.gitUrl, 'https://github.com/chapmanjw/kiro-crew-vscode-app');
  assert.equal(entry.branch, 'main');
  // app.json sits at the repo root, so there is no subdirectory ('.' is refused by the gateway).
  assert.ok(!('subdirectory' in entry));
  assert.ok(fs.existsSync(path.join(ROOT, 'app.json')));
});

test('the store name, the rail label and the art are set separately', () => {
  assert.equal(manifest.displayName, 'Visual Studio Code Server Integration');
  assert.equal(manifest.ui.pages[0].label, 'Code');
  // iconPath is the flat VS Code mark (store, detail page, and the rail's hover and selected rows).
  assert.equal(manifest.iconPath, 'assets/icon-blue.svg');
  assert.equal(manifest.heroImage, 'assets/store-hero.svg');
  assert.equal(manifest.heroImageDetail, 'assets/store-hero-detail.svg');
  for (const rel of [manifest.heroImage, manifest.heroImageDetail]) {
    const svg = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(svg, /^<svg /);
    assert.doesNotMatch(svg, /<script|href=|url\(http/i, `${rel} is self-contained`);
  }
});
