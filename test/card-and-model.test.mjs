// The card sits where the Kiro Crew Sessions card does, and the
// bridge publishes its language model at activation so a plain first chat
// message carries a model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';

import { Bridge } from '../backend/lib/bridge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreFile = fs.readdirSync(path.join(ROOT, 'ui')).find((f) => /^vscode-pane-core-.*\.mjs$/.test(f));
const core = await import(`../ui/${coreFile}`);

test('card margin matches the Sessions card: flush with <main> left and top, 8px right and bottom', () => {
  assert.deepEqual({ ...core.CARD_MARGIN }, { top: 0, right: 8, bottom: 8, left: 0 });
  assert.ok(Object.isFrozen(core.CARD_MARGIN));
  const page = fs.readFileSync(path.join(ROOT, 'ui', JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8')).ui.entry), 'utf8');
  assert.match(page, /margin:\$\{CARD_MARGIN\.top\}px \$\{CARD_MARGIN\.right\}px \$\{CARD_MARGIN\.bottom\}px \$\{CARD_MARGIN\.left\}px/);
  assert.doesNotMatch(page, /\bINSET\b/, 'no leftover uniform inset');
});

test('Bridge keeps whether the bridge published its language model', () => {
  const b = new Bridge();
  b.applyEvent({ type: 'hello', chat: { participant: true, defaultParticipant: true, model: true, modelPublished: true } });
  assert.equal(b.extension.chat.modelPublished, true);
  b.applyEvent({ type: 'hello', chat: { participant: true, defaultParticipant: true, model: true, modelPublished: 'yes' } });
  assert.equal(b.extension.chat.modelPublished, false, 'only a real true counts');
});

/** Load extension.js against a fake `vscode` module and record what it calls, in order. */
function loadBridgeExtension({ selectResult = [{ vendor: 'kiro-crew', id: 'kiro-crew' }] } = {}) {
  const calls = [];
  let provider = null;
  let fired = 0;
  class EventEmitter {
    constructor() {
      this.listeners = [];
      this.event = (fn) => {
        this.listeners.push(fn);
        return { dispose() {} };
      };
    }
    fire() {
      fired++;
      calls.push('changeEvent');
      for (const fn of this.listeners) fn();
    }
    dispose() {}
  }
  const fakeVscode = {
    EventEmitter,
    StatusBarAlignment: { Left: 1 },
    ConfigurationTarget: { Global: 1 },
    Uri: { joinPath: (base, p) => ({ path: `${base.path}/${p}` }) },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      activeTextEditor: undefined,
    },
    commands: { registerCommand: () => ({ dispose() {} }) },
    workspace: { workspaceFolders: [] },
    lm: {
      registerLanguageModelChatProvider: (vendor, p) => {
        calls.push(`registerProvider:${vendor}`);
        provider = p;
        return { dispose() {} };
      },
      selectChatModels: async (selector) => {
        calls.push(`selectChatModels:${JSON.stringify(selector)}`);
        return selectResult;
      },
    },
    chat: {
      createChatParticipant: (id) => {
        calls.push(`participant:${id}`);
        return { dispose() {} };
      },
    },
  };
  const file = path.join(ROOT, 'extension', 'kiro-crew-bridge', 'extension.js');
  const origLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return fakeVscode;
    return origLoad.call(this, request, parent, isMain);
  };
  const saved = { url: process.env.KIROCREW_VSCODE_BRIDGE_URL, secret: process.env.KIROCREW_VSCODE_BRIDGE_SECRET };
  delete process.env.KIROCREW_VSCODE_BRIDGE_URL;
  delete process.env.KIROCREW_VSCODE_BRIDGE_SECRET;
  try {
    delete Module._cache[file];
    const req = Module.createRequire(file);
    const ext = req(file);
    return { ext, calls, getProvider: () => provider, getFired: () => fired };
  } finally {
    Module._load = origLoad;
    if (saved.url !== undefined) process.env.KIROCREW_VSCODE_BRIDGE_URL = saved.url;
    if (saved.secret !== undefined) process.env.KIROCREW_VSCODE_BRIDGE_SECRET = saved.secret;
  }
}

test('bridge extension: provider registered and published before the chat participants', async () => {
  const { ext, calls, getProvider, getFired } = loadBridgeExtension();
  ext.activate({ subscriptions: [], extensionUri: { path: '/ext' } });
  await new Promise((r) => setImmediate(r));
  const reg = calls.indexOf('registerProvider:kiro-crew');
  const select = calls.indexOf('selectChatModels:{"vendor":"kiro-crew"}');
  const firstParticipant = calls.findIndex((c) => c.startsWith('participant:'));
  assert.ok(reg >= 0, calls.join(', '));
  assert.ok(select > reg, `the vendor is resolved after it is registered: ${calls.join(', ')}`);
  assert.ok(firstParticipant > reg, `the provider comes before the participants: ${calls.join(', ')}`);
  assert.ok(getFired() >= 1, 'the change event fires so the workbench asks for the models');
  const p = getProvider();
  assert.equal(typeof p.onDidChangeLanguageModelChatInformation, 'function');
  const [info] = p.provideLanguageModelChatInformation();
  // chat.defaultModel ("kiro-crew", set by the launcher) matches by model id.
  assert.equal(info.id, 'kiro-crew');
  ext.deactivate();
});

test('bridge extension: activation still registers both participants when the vendor resolves no model', async () => {
  const { ext, calls } = loadBridgeExtension({ selectResult: [] });
  ext.activate({ subscriptions: [], extensionUri: { path: '/ext' } });
  await new Promise((r) => setImmediate(r));
  assert.ok(calls.includes('selectChatModels:{"vendor":"kiro-crew"}'));
  assert.deepEqual(calls.filter((c) => c.startsWith('participant:')), ['participant:kiro-crew.default', 'participant:kiro-crew.agent']);
  ext.deactivate();
});

test('launcher Machine settings default new chats to the Kiro Crew model', async () => {
  const { chatSettings } = await import('../backend/lib/chatprefs.mjs');
  assert.equal(chatSettings()['chat.defaultModel'], 'kiro-crew');
  assert.equal(chatSettings({ hideCopilotAgents: false })['chat.defaultModel'], 'kiro-crew');
  const src = fs.readFileSync(path.join(ROOT, 'backend', 'launcher.mjs'), 'utf8');
  assert.match(src, /seedThemeSettings\(withTerminal, vsTheme, \{ \.\.\.chatSettings\(chatPrefs\), \.\.\.layoutSettings\(\) \}\)/, 'the launcher seeds chatSettings (with the layout density) into Machine settings');
});
