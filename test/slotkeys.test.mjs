// Session keys in their slot form. The dashboard names a chat `dashboard:<slot>`, and
// the embed and the tab store use the slot alone (backend/lib/tabs.mjs slotOf, and
// ui/vscode-pane-core-*.mjs slotOfSession). So a chat's tab, its embed path and its chip
// URL agree, whichever form the key arrived in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TabStore, parseTabs, slotOf, validSessionKey } from '../backend/lib/tabs.mjs';
import { embedPathFor, EMBED_PATH_RE } from '../backend/lib/kctab.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreFile = fs.readdirSync(path.join(ROOT, 'ui')).find((f) => /^vscode-pane-core-.*\.mjs$/.test(f));
const core = await import(pathToFileURL(path.join(ROOT, 'ui', coreFile)).href);

test('slotOf drops one dashboard: prefix, then any dashboard_ prefixes, as the dashboard does', () => {
  assert.equal(slotOf('dashboard:chat-1'), 'chat-1');
  assert.equal(slotOf('dashboard_chat-1'), 'chat-1');
  assert.equal(slotOf('dashboard:dashboard_dashboard_chat-1'), 'chat-1');
  assert.equal(slotOf('chat-1'), 'chat-1');
  assert.equal(slotOf('dashboard:chat:1'), 'chat:1', 'only the prefix goes');
  assert.equal(slotOf(undefined), '');
});

test('validSessionKey returns the slot of a valid key, and null for anything that is not a slot', () => {
  assert.equal(validSessionKey('dashboard:chat-1'), 'chat-1');
  assert.equal(validSessionKey('chat-1'), 'chat-1');
  for (const bad of ['', 'dashboard:', 'dashboard:dashboard_', 'dashboard:a b', 'a:b', 'dashboard:x/y', 'x'.repeat(201)]) assert.equal(validSessionKey(bad), null, bad);
});

test('the tab store keeps a chat in slot form, finds its tab by either form, and loads older files that kept the prefix', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vsp-slot-')), 'tabs.json');
  let n = 0;
  const s = new TabStore({ file, now: () => 1000 + n, newId: () => `t${String(++n).padStart(12, '0')}` });
  const opened = s.open({ folder: '/w/a', session: 'dashboard:chat-1' });
  assert.equal(opened.tab.session, 'chat-1');
  assert.equal(s.bySession('dashboard:chat-1').id, opened.tab.id);
  assert.equal(s.bySession('chat-1').id, opened.tab.id);
  assert.equal(s.open({ folder: '/elsewhere', session: 'dashboard:chat-1' }).created, false, 'the chip again brings the tab back');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tabs[0].session, 'chat-1', 'the file holds the slot');
  const older = parseTabs(JSON.stringify({ tabs: [{ id: 't000000000009', folder: '/w/b', session: 'dashboard:chat-2' }], active: 't000000000009' }));
  assert.equal(older.tabs[0].session, 'chat-2');
});

test('the page reads and builds the slot form: a URL with the prefix and one without open the same tab', () => {
  const { appPageUrl, intentFromSearch, sessionTitles, slotOfSession } = core;
  assert.equal(slotOfSession('dashboard:chat-1'), 'chat-1');
  assert.equal(slotOfSession(null), '');
  assert.equal(appPageUrl('/w/a', 'dashboard:chat-1'), '/apps/vscode-pane?folder=%2Fw%2Fa&session=chat-1');
  assert.equal(appPageUrl('/w/a', 'dashboard:chat-1'), appPageUrl('/w/a', 'chat-1'));
  assert.deepEqual(intentFromSearch('?session=dashboard%3Achat-1'), { folder: '', session: 'chat-1', tab: '' });
  assert.deepEqual(intentFromSearch('?session=chat-1'), { folder: '', session: 'chat-1', tab: '' });
  assert.deepEqual(sessionTitles([{ key: 'dashboard:chat-1', title: 'Fix the build' }]), { 'chat-1': 'Fix the build' }, 'titles are keyed by slot, the key a tab looks them up by');
});

test('the embed path names the slot, whichever form the key came in', () => {
  assert.equal(embedPathFor('dashboard:chat-1'), '/embed/chat/chat-1?sid=chat-1');
  assert.equal(embedPathFor('chat-1'), '/embed/chat/chat-1?sid=chat-1');
  assert.match(embedPathFor('dashboard:chat-1'), EMBED_PATH_RE);
  assert.equal(embedPathFor('dashboard:'), '/embed/sessions', 'no chat, no chat view');
});
