// The VS Code server update rules: which build the app owns, the install record,
// the update decision, the update service's addresses and the page's labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { updateBase, ownedBuild, buildName, readRecord, writeRecord, recordedDir, decideUpdate, removableBuilds, COMMIT_RE } from '../backend/lib/serverbuild.mjs';
import { serverLatestMetadataUrl, serverMetadataUrl, nodeExeName, PUBLIC_UPDATE_BASE } from '../backend/lib/discovery.mjs';
import { matchRoute } from '../backend/lib/router.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-su-'));

test('updateBase keeps the public service unless a loopback stand-in is named', () => {
  assert.equal(updateBase(undefined), PUBLIC_UPDATE_BASE);
  assert.equal(updateBase(''), PUBLIC_UPDATE_BASE);
  assert.equal(updateBase('https://evil.example'), PUBLIC_UPDATE_BASE);
  assert.equal(updateBase('http://evil.example:8080'), PUBLIC_UPDATE_BASE);
  assert.equal(updateBase('http://127.0.0.1:4321/'), 'http://127.0.0.1:4321');
  assert.equal(updateBase('http://localhost'), 'http://localhost');
});

test('ownedBuild: the app owns a build it put in its data folder or downloaded, unless a code command pins the server', () => {
  assert.equal(ownedBuild({ source: 'data' }), true);
  assert.equal(ownedBuild({ source: 'download' }), true);
  assert.equal(ownedBuild({ source: 'data' }, A), false, 'a code command pins the server to the VS Code of the user');
  assert.equal(ownedBuild({ source: 'configured' }), false);
  assert.equal(ownedBuild({ source: 'dev-cache' }), false);
  assert.equal(ownedBuild(null), false);
});

test('buildName reads the version from product.json and nothing else', () => {
  const dir = tmp();
  try {
    assert.equal(buildName(dir), null);
    fs.writeFileSync(path.join(dir, 'product.json'), JSON.stringify({ version: '1.146.0', commit: A }));
    assert.equal(buildName(dir), '1.146.0');
    fs.writeFileSync(path.join(dir, 'product.json'), JSON.stringify({ version: 'latest' }));
    assert.equal(buildName(dir), null);
    fs.writeFileSync(path.join(dir, 'product.json'), '{not json');
    assert.equal(buildName(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the install record round-trips, is owner-only, and refuses anything malformed', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'state', 'server-build.json');
    assert.equal(readRecord(file), null);
    writeRecord(file, { commit: B, name: '1.200.0', installedAt: '2026-11-17T00:00:00Z', via: 'update', previous: { commit: A, name: '1.100.0' } });
    const rec = readRecord(file);
    assert.equal(rec.commit, B);
    assert.equal(rec.name, '1.200.0');
    assert.deepEqual(rec.previous, { commit: A, name: '1.100.0' });
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, JSON.stringify({ commit: 'not-a-commit' }));
    assert.equal(readRecord(file), null);
    fs.writeFileSync(file, JSON.stringify({ commit: A, name: 'x', previous: { commit: 'bad' } }));
    const odd = readRecord(file);
    assert.equal(odd.name, null);
    assert.equal(odd.previous, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recordedDir names a folder only while it is a server build', () => {
  const dataDir = tmp();
  try {
    assert.equal(recordedDir({ dataDir, commit: A }), null);
    const build = path.join(dataDir, 'server', A);
    fs.mkdirSync(path.join(build, 'out'), { recursive: true });
    fs.writeFileSync(path.join(build, nodeExeName()), '');
    assert.equal(recordedDir({ dataDir, commit: A }), null, 'no server-main.js yet');
    fs.writeFileSync(path.join(build, 'out', 'server-main.js'), '');
    assert.equal(recordedDir({ dataDir, commit: A }), build);
    assert.equal(recordedDir({ dataDir, commit: '../escape' }), null);
    assert.equal(recordedDir({ dataDir, commit: undefined }), null);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('decideUpdate offers only a different stable build', () => {
  assert.equal(decideUpdate({ installedCommit: A, latest: { commit: B } }).available, true);
  assert.equal(decideUpdate({ installedCommit: A, latest: { commit: A } }).available, false);
  assert.equal(decideUpdate({ installedCommit: A, latest: null }).available, false);
  assert.equal(decideUpdate({ installedCommit: A, latest: { commit: 'x' } }).available, false);
});

test('removableBuilds names only commit-named folders other than the one kept', () => {
  assert.deepEqual(removableBuilds([A, B, 'notes', '.staging-1'], B), [A]);
  assert.deepEqual(removableBuilds([], B), []);
  assert.equal(COMMIT_RE.test(A), true);
});

test('the metadata addresses follow the update base', () => {
  const base = 'http://127.0.0.1:9999';
  assert.equal(serverLatestMetadataUrl('linux', 'x64'), 'https://update.code.visualstudio.com/api/update/server-linux-x64-web/stable/latest');
  assert.equal(serverLatestMetadataUrl('linux', 'x64', base), `${base}/api/update/server-linux-x64-web/stable/latest`);
  assert.equal(serverMetadataUrl(A, 'linux', 'arm64', base), `${base}/api/versions/commit:${A}/server-linux-arm64-web/stable`);
  assert.equal(serverMetadataUrl(A, 'linux', 'arm64'), `https://update.code.visualstudio.com/api/versions/commit:${A}/server-linux-arm64-web/stable`);
});

test('the update routes are signed POST routes', () => {
  assert.deepEqual(matchRoute('POST', '/api/server-update/check', null), { name: 'serverUpdateCheck', auth: 'proxy' });
  assert.deepEqual(matchRoute('POST', '/api/server-update/install', null), { name: 'serverUpdateInstall', auth: 'proxy' });
  assert.deepEqual(matchRoute('GET', '/api/server-update/check', null), { error: 405 });
});

test('buildLabel, updateButton and updateBanner describe each update state for the page', async () => {
  const coreFile = fs.readdirSync(path.join(ROOT, 'ui')).find((f) => /^vscode-pane-core-.*\.mjs$/.test(f));
  const { buildLabel, updateButton, updateBanner } = await import(pathToFileURL(path.join(ROOT, 'ui', coreFile)).href);
  const cur = { name: '1.146.0', commit: A };
  const next = { name: '1.147.0', commit: B };
  assert.equal(buildLabel(cur), 'VS Code 1.146.0');
  assert.equal(buildLabel({ commit: A }), `VS Code ${'a'.repeat(8)}`);
  assert.deepEqual(updateButton(null), { label: 'Check for updates', disabled: false });
  assert.deepEqual(updateButton({ phase: 'checking' }), { label: 'Checking...', disabled: true });
  assert.deepEqual(updateButton({ phase: 'current', installed: cur }), { label: 'Up to date', disabled: false });
  assert.deepEqual(updateButton({ phase: 'downloading' }), { label: 'Updating...', disabled: true });
  assert.deepEqual(updateButton({ phase: 'failed', what: 'check' }), { label: 'Check for updates', disabled: false });
  assert.equal(updateBanner(null), null);
  assert.equal(updateBanner({ phase: 'current', installed: cur }), null);
  const avail = updateBanner({ phase: 'available', installed: cur, latest: next });
  assert.match(avail.text, /VS Code 1\.147\.0 is available/);
  assert.equal(avail.install, B);
  assert.equal(avail.installLabel, 'Update to 1.147.0');
  assert.equal(updateBanner({ phase: 'downloading', message: 'Unpacking VS Code server', latest: next }).text, 'Unpacking VS Code server (VS Code 1.147.0)');
  assert.equal(updateBanner({ phase: 'done', installed: next }).text, 'Now running VS Code 1.147.0.');
  const failed = updateBanner({ phase: 'failed', what: 'update', error: 'VS Code 1.300.0 did not start' });
  assert.equal(failed.tone, 'error');
  assert.equal(failed.install, null);
  assert.equal(failed.text, 'VS Code 1.300.0 did not start');
});
