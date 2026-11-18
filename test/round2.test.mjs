// Round 2: Kiro Crew theme -> VS Code, the built-in Chat backed by the Kiro
// Crew gateway, and a stable frame origin across launcher restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateTheme, toVsCodeTheme, derivePalette, seedThemeSettings, themeSignature, contrast, normalizeHex,
  THEME_KEYS, MAX_THEME_BYTES,
} from '../backend/lib/theme.mjs';
import {
  GatewayClient, SseParser, TurnRenderer, cookieNameFor, slotNameFor, gatewayOriginAllowed, TOKEN_TTL_MS,
} from '../backend/lib/gateway.mjs';
import { parseChatRequest, runChatTurn, MAX_PROMPT } from '../backend/lib/chatbridge.mjs';
import { parseFrameState, frameStateFor, frameStateHasKey, serializeFrameState } from '../backend/lib/framestate.mjs';
import { Bridge } from '../backend/lib/bridge.mjs';
import { buildServerArgs } from '../backend/lib/args.mjs';
import { matchRoute } from '../backend/lib/router.mjs';
import { createGatewayMock, MOCK_REPLY } from './support/gateway-mock.mjs';

const DRACULA = {
  kind: 'dark',
  vars: {
    '--bg': '#282a36', '--surface': '#343746', '--panel': '#21222c', '--border': '#44475a',
    '--text': '#f8f8f2', '--muted': '#a5a9c0', '--accent': '#bd93f9',
  },
};
const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/;

// ---------------------------------------------------------------- theme validation

test('validateTheme accepts the contract body and normalises hex', () => {
  const v = validateTheme({ kind: 'light', vars: { '--bg': '#FFF', '--text': '#111111', '--accent': '#3366ccff' } });
  assert.deepEqual(v.theme, { kind: 'light', vars: { '--accent': '#3366ccff', '--bg': '#ffffff', '--text': '#111111' } });
});

test('validateTheme refuses anything but known keys, hex colours and the two kinds', () => {
  const ok = { '--bg': '#000000', '--text': '#ffffff' };
  const bad = [
    [null, /object/],
    [[], /object/],
    [{ kind: 'sepia', vars: ok }, /kind/],
    [{ kind: 'dark' }, /vars/],
    [{ kind: 'dark', vars: [] }, /vars/],
    [{ kind: 'dark', vars: { ...ok, '--font': '#000000' } }, /unknown variable/],
    [{ kind: 'dark', vars: { ...ok, ['__proto__']: '#000000' } }, /unknown variable|required/],
    [{ kind: 'dark', vars: { ...ok, '--accent': 'red' } }, /hex/],
    [{ kind: 'dark', vars: { ...ok, '--accent': 'url(http://x)' } }, /hex/],
    [{ kind: 'dark', vars: { ...ok, '--accent': '#12345' } }, /hex/],
    [{ kind: 'dark', vars: { ...ok, '--accent': 7 } }, /hex/],
    [{ kind: 'dark', vars: { '--text': '#ffffff' } }, /--bg is required/],
    [{ kind: 'dark', vars: ok, extra: 1 }, /unknown field/],
  ];
  for (const [body, re] of bad) {
    const v = validateTheme(body);
    assert.ok(v.error && re.test(v.error), `${JSON.stringify(body)} -> ${v.error}`);
  }
  assert.match(validateTheme({ kind: 'dark', vars: ok }, MAX_THEME_BYTES + 1).error, /bytes/);
  // JSON.parse makes __proto__ an own key, which must be refused like any unknown name.
  assert.ok(validateTheme(JSON.parse('{"kind":"dark","vars":{"--bg":"#000","--text":"#fff","__proto__":"#000"}}')).error);
});

test('THEME_KEYS covers the contract names', () => {
  for (const k of ['--bg', '--surface', '--panel', '--border', '--text', '--muted', '--accent']) assert.ok(THEME_KEYS.includes(k), k);
});

// ---------------------------------------------------------------- mapping

test('toVsCodeTheme picks the base theme by kind and covers every workbench area', () => {
  const dark = toVsCodeTheme(validateTheme(DRACULA).theme);
  assert.equal(dark.colorTheme, 'Dark Modern');
  const light = toVsCodeTheme(validateTheme({ kind: 'light', vars: { '--bg': '#ffffff', '--text': '#1f2328' } }).theme);
  assert.equal(light.colorTheme, 'Light Modern');
  const c = dark.colorCustomizations;
  const required = [
    'editor.background', 'editor.foreground', 'sideBar.background', 'activityBar.background', 'titleBar.activeBackground',
    'statusBar.background', 'panel.background', 'tab.activeBackground', 'tab.inactiveBackground', 'list.activeSelectionBackground',
    'list.hoverBackground', 'input.background', 'input.border', 'button.background', 'button.foreground', 'focusBorder',
    'chat.requestBackground', 'terminal.background', 'dropdown.background', 'menu.background', 'quickInput.background',
  ];
  for (const k of required) assert.match(c[k], HEX, k);
  for (const [k, v] of Object.entries(c)) assert.match(v, HEX, `${k}=${v}`);
  assert.equal(c['editor.background'], '#282a36');
  assert.equal(c['sideBar.background'], '#21222c', '--panel drives the side bar');
  assert.equal(c['editorWidget.background'], '#343746', '--surface drives widgets');
  assert.equal(c['focusBorder'], '#bd93f9');
  assert.equal(c['input.border'], '#44475a');
  assert.equal(c['descriptionForeground'], '#a5a9c0');
});

test('missing shades are derived from --bg, --text and --accent', () => {
  const t = validateTheme({ kind: 'dark', vars: { '--bg': '#101014', '--text': '#e6e6e6', '--accent': '#ffcc00' } }).theme;
  const p = derivePalette(t);
  for (const k of ['surface', 'panel', 'border', 'muted', 'hover', 'chrome']) assert.match(p[k], HEX, k);
  assert.notEqual(p.surface, p.bg);
  assert.ok(contrast(p.border, p.bg) > 1.2, 'border is visible against bg');
  assert.ok(contrast(p.muted, p.bg) >= 3, 'muted text stays readable');
  const c = toVsCodeTheme(t).colorCustomizations;
  assert.equal(c['button.foreground'], '#000000', 'dark text on a yellow button');
  assert.ok(contrast(c['button.foreground'], c['button.background']) >= 4.5);
  const blue = toVsCodeTheme(validateTheme({ kind: 'light', vars: { '--bg': '#ffffff', '--text': '#000000', '--accent': '#1d4ed8' } }).theme);
  assert.equal(blue.colorCustomizations['button.foreground'], '#ffffff');
});

test('themeSignature is stable and changes with the palette', () => {
  const a = toVsCodeTheme(validateTheme(DRACULA).theme);
  const b = toVsCodeTheme(validateTheme(JSON.parse(JSON.stringify(DRACULA))).theme);
  assert.equal(themeSignature(a), themeSignature(b));
  const c = toVsCodeTheme(validateTheme({ ...DRACULA, vars: { ...DRACULA.vars, '--accent': '#ff79c6' } }).theme);
  assert.notEqual(themeSignature(a), themeSignature(c));
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
});

test('seedThemeSettings writes the theme and chat settings and keeps other settings', () => {
  const vs = toVsCodeTheme(validateTheme(DRACULA).theme);
  const out = JSON.parse(seedThemeSettings('{"editor.fontSize": 15}', vs, { 'chat.titleBar.signIn.enabled': false }));
  assert.equal(out['editor.fontSize'], 15);
  assert.equal(out['workbench.colorTheme'], 'Dark Modern');
  assert.equal(out['workbench.colorCustomizations']['editor.background'], '#282a36');
  assert.equal(out['chat.titleBar.signIn.enabled'], false);
  assert.equal(seedThemeSettings('// comment\n{}', vs), null, 'a file with comments is left alone');
  const noTheme = JSON.parse(seedThemeSettings('', null, { a: 1 }));
  assert.deepEqual(noTheme, { a: 1 });
});

// ---------------------------------------------------------------- gateway helpers

test('cookieNameFor and gatewayOriginAllowed', () => {
  assert.equal(cookieNameFor('http://localhost:5476'), 'mc_token_5476');
  assert.equal(cookieNameFor('https://127.0.0.1'), 'mc_token_443');
  assert.ok(gatewayOriginAllowed('http://localhost:5476'));
  assert.ok(gatewayOriginAllowed('http://127.0.0.1:1'));
  assert.ok(!gatewayOriginAllowed('http://evil.example:5476'));
  assert.ok(!gatewayOriginAllowed('file:///x'));
  assert.ok(!gatewayOriginAllowed('http://u:p@localhost:5476'));
  assert.ok(!gatewayOriginAllowed('not a url'));
});

test('slotNameFor is deterministic, safe and per folder', () => {
  const a = slotNameFor('C:\\Users\\me\\Projects\\My App');
  assert.match(a, /^vscode-my-app-[0-9a-f]{10}$/);
  assert.equal(slotNameFor('C:\\Users\\me\\Projects\\My App\\'), a);
  assert.notEqual(slotNameFor('C:\\Users\\me\\Projects\\Other'), a);
  if (process.platform === 'win32') assert.equal(slotNameFor('c:\\users\\ME\\projects\\my app'), a);
  assert.match(slotNameFor('/'), /^vscode-workspace-/);
});

test('SseParser handles split frames, CRLF and comments', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: {"a"'), []);
  assert.deepEqual(p.push(':1}\n\n: keepalive\n\ndata: x\r\n\r\ndata: [DO'), ['{"a":1}', 'x']);
  assert.deepEqual(p.push('NE]\n\n'), ['[DONE]']);
});

test('TurnRenderer streams chunks once and maps tools, approvals and errors', () => {
  const r = new TurnRenderer();
  const out = [
    { type: 'user', content: 'hi' },
    { type: 'chunk', content: 'Hello ' },
    { type: 'chunk', content: 'world.' },
    { type: 'tool', content: '🔧 Reading\n  file.txt' },
    { type: 'assistant', content: 'Hello world.' },
    { type: 'assistant', content: 'Second segment.' },
    { type: 'permission', content: 'Run shell', cls: '{"tool_call_id":"t"}' },
    { type: 'permission', content: 'Run shell', cls: '{"resolved":"rejected"}' },
    { type: 'error', content: 'model failed' },
    { type: 'thinking', content: 'secret thoughts' },
    { type: 'brand-new-kind', content: 'x' },
  ].flatMap((row) => r.push(row));
  assert.deepEqual(out, [
    { kind: 'markdown', text: 'Hello ' },
    { kind: 'markdown', text: 'world.' },
    { kind: 'progress', text: '🔧 Reading file.txt' },
    { kind: 'markdown', text: '\n\nSecond segment.' },
    { kind: 'warning', text: 'Kiro Crew is waiting for your approval: Run shell. Approve or reject it in the Kiro Crew session.' },
    { kind: 'progress', text: 'Run shell (rejected)' },
    { kind: 'warning', text: 'model failed' },
  ]);
  const tail = new TurnRenderer();
  tail.push({ type: 'chunk', content: 'Hel' });
  assert.deepEqual(tail.push({ type: 'assistant', content: 'Hello' }), [{ kind: 'markdown', text: 'lo' }], 'held text after the last chunk');
});

// ---------------------------------------------------------------- gateway client against the mock

async function withMock(opts, fn) {
  const mock = createGatewayMock({ secret: 's3cret', ...opts });
  const origin = await mock.listen();
  try {
    await fn(mock, origin);
  } finally {
    await mock.close();
  }
}

test('GatewayClient exchanges the secret once, sends the cookie and reuses the token', async () => {
  await withMock({}, async (mock, origin) => {
    const g = new GatewayClient({ origin, appName: 'vscode-pane', secret: 's3cret' });
    assert.equal((await g.status()).version, '0.0.0-mock');
    await g.status();
    assert.equal(mock.rec.exchanges, 1);
    assert.ok(g.tokenExpiresAt());
  });
});

test('GatewayClient re-exchanges and replays after a 401 (expired token)', async () => {
  await withMock({ rejectFirstTokens: 1 }, async (mock, origin) => {
    const g = new GatewayClient({ origin, appName: 'vscode-pane', secret: 's3cret' });
    assert.equal((await g.status()).version, '0.0.0-mock');
    assert.equal(mock.rec.exchanges, 2);
  });
});

test('GatewayClient refreshes the token before the hour is up', async () => {
  await withMock({}, async (mock, origin) => {
    let t = 1_000_000;
    const g = new GatewayClient({ origin, appName: 'vscode-pane', secret: 's3cret', now: () => t });
    await g.status();
    t += TOKEN_TTL_MS - 20 * 60_000; // 40 min later: still fresh
    await g.status();
    assert.equal(mock.rec.exchanges, 1);
    t += 15 * 60_000; // 55 min: inside the refresh margin
    await g.status();
    assert.equal(mock.rec.exchanges, 2);
  });
});

test('GatewayClient reports a refused exchange and a missing configuration', async () => {
  await withMock({}, async (_mock, origin) => {
    const g = new GatewayClient({ origin, appName: 'vscode-pane', secret: 'wrong' });
    await assert.rejects(g.status(), (e) => e.code === 'token' && /HTTP 403/.test(e.message));
  });
  assert.match(new GatewayClient({ origin: '', appName: 'a', secret: 's' }).unavailableReason, /GATEWAY_ORIGIN/);
  assert.match(new GatewayClient({ origin: 'http://localhost:5476', appName: 'a', secret: '' }).unavailableReason, /PROXY_SECRET/);
  assert.match(new GatewayClient({ origin: 'http://example.com', appName: 'a', secret: 's' }).unavailableReason, /loopback/);
});

test('ensureSlot creates the folder slot once and sets its project', async () => {
  await withMock({}, async (mock, origin) => {
    const g = new GatewayClient({ origin, appName: 'vscode-pane', secret: 's3cret' });
    const folder = process.platform === 'win32' ? 'C:\\work\\demo' : '/work/demo';
    const key = await g.ensureSlot(folder);
    assert.equal(key, slotNameFor(folder));
    assert.equal(await g.ensureSlot(folder), key);
    assert.deepEqual(mock.rec.projects, [{ key, project: folder }]);
    assert.equal(mock.rec.slots.get(key).title, 'VS Code: demo');
  });
});

// ---------------------------------------------------------------- one chat turn

test('runChatTurn streams a Kiro Crew turn as chat parts', async () => {
  await withMock({}, async (mock, origin) => {
    const g = new GatewayClient({ origin, appName: 'vscode-pane', secret: 's3cret' });
    const parts = [];
    const r = await runChatTurn({ gateway: g, prompt: 'say hi', folder: process.cwd(), signal: new AbortController().signal, write: (p) => parts.push(p) });
    assert.equal(r.outcome, 'done');
    assert.equal(mock.rec.turns[0].message, 'say hi');
    const md = parts.filter((p) => p.kind === 'markdown').map((p) => p.text).join('');
    assert.equal(md, MOCK_REPLY, 'the closing assistant row does not repeat the streamed text');
    assert.ok(parts.some((p) => p.kind === 'progress' && /Reading hello\.txt/.test(p.text)));
    assert.ok(parts.some((p) => p.kind === 'warning' && /approval/.test(p.text)));
    assert.deepEqual(parts[0], { kind: 'session', slot: r.slot });
    assert.deepEqual(parts.at(-1), { kind: 'done', slot: r.slot, complete: true });
  });
});

test('runChatTurn stops the Kiro Crew turn when VS Code cancels', async () => {
  await withMock({}, async (mock, origin) => {
    const g = new GatewayClient({ origin, appName: 'vscode-pane', secret: 's3cret' });
    const ac = new AbortController();
    const parts = [];
    const run = runChatTurn({ gateway: g, prompt: 'be slow', folder: process.cwd(), signal: ac.signal, write: (p) => parts.push(p) });
    while (!parts.some((p) => p.kind === 'markdown')) await new Promise((ok) => setTimeout(ok, 20));
    ac.abort();
    const r = await run;
    assert.equal(r.outcome, 'cancelled');
    assert.deepEqual(mock.rec.stops, [r.slot]);
    await new Promise((ok) => setTimeout(ok, 100));
    assert.deepEqual(mock.rec.aborted, [r.slot], 'the SSE request was closed');
  });
});

test('runChatTurn reports a queued turn and a gateway error', async () => {
  await withMock({}, async (_mock, origin) => {
    const g = new GatewayClient({ origin, appName: 'vscode-pane', secret: 's3cret' });
    const parts = [];
    const q = await runChatTurn({ gateway: g, prompt: 'please queue me', folder: process.cwd(), signal: new AbortController().signal, write: (p) => parts.push(p) });
    assert.equal(q.outcome, 'queued');
    assert.ok(parts.some((p) => p.kind === 'warning' && /queued/.test(p.text)));
  });
  const parts = [];
  const g = new GatewayClient({ origin: 'http://127.0.0.1:9', appName: 'vscode-pane', secret: 's' });
  const r = await runChatTurn({ gateway: g, prompt: 'x', folder: process.cwd(), signal: new AbortController().signal, write: (p) => parts.push(p) });
  assert.equal(r.outcome, 'error');
  assert.match(parts.at(-1).text, /unreachable/);
});

test('parseChatRequest validates the bridge body', () => {
  const folder = process.cwd();
  assert.deepEqual(parseChatRequest({ prompt: 'hi', folder }), { prompt: 'hi', folder });
  assert.deepEqual(parseChatRequest({ prompt: 'hi' }, { defaultFolder: folder }), { prompt: 'hi', folder });
  assert.match(parseChatRequest({ prompt: '  ' }).error, /prompt/);
  assert.match(parseChatRequest({ prompt: 'x'.repeat(MAX_PROMPT + 1), folder }).error, /prompt/);
  assert.match(parseChatRequest({ prompt: 'hi', folder: 'relative' }).error, /absolute/);
  assert.match(parseChatRequest({ prompt: 'hi', folder: folder + '\0' }).error, /absolute/);
  assert.match(parseChatRequest({ prompt: 'hi' }).error, /absolute/);
  assert.match(parseChatRequest(null).error, /object/);
});

// ---------------------------------------------------------------- frame state, bridge, args, routes

test('frame state persists only the port; the key is new each run; bad files fall back', () => {
  const text = serializeFrameState({ key: 'k'.repeat(24), port: 61234 });
  assert.deepEqual(JSON.parse(text), { port: 61234 }, 'the key is never written');
  assert.equal(frameStateHasKey(text), false);
  const a = frameStateFor(parseFrameState(text));
  const b = frameStateFor(parseFrameState(text));
  assert.equal(a.port, 61234);
  assert.match(a.key, /^[A-Za-z0-9_-]{24}$/);
  assert.notEqual(a.key, b.key, 'a new key for every run');
  // A 0.3.0-dev file with a saved key: the key is ignored and flagged for rewrite.
  const legacy = '{"key": "' + 'k'.repeat(24) + '", "port": 61234}';
  assert.deepEqual(parseFrameState(legacy), { port: 61234 });
  assert.equal(frameStateHasKey(legacy), true);
  assert.notEqual(frameStateFor(parseFrameState(legacy)).key, 'k'.repeat(24));
  assert.deepEqual(parseFrameState('{"port": 80}'), {});
  assert.deepEqual(parseFrameState('not json'), {});
  assert.equal(frameStateFor({}).port, 0);
});

test('Bridge records chat capability, theme results, and keeps only the newest theme command', () => {
  const b = new Bridge();
  b.applyEvent({ type: 'hello', version: '0.3.0', chat: { participant: true, defaultParticipant: true, error: null } });
  assert.deepEqual(b.extension.chat, { participant: true, defaultParticipant: true, model: false, modelPublished: false, sessionType: false, sessionModelPublished: false, error: null });
  b.enqueue({ kind: 'openFile', path: '/a' }, 50);
  b.enqueueLatest({ kind: 'applyTheme', theme: { signature: '1' } }, 50);
  b.enqueueLatest({ kind: 'applyTheme', theme: { signature: '2' } }, 50);
  assert.deepEqual(b.queue.map((c) => c.theme?.signature ?? c.kind), ['openFile', '2']);
  b.applyEvent({ type: 'theme', signature: '2', applied: true, changed: true });
  assert.equal(b.snapshot().theme.applied, true);
});

test('Bridge: each window takes its own commands; a tab\'s commands go to its newest window, and a reloaded window\'s old host gets none', async () => {
  let t = 1000;
  const b = new Bridge({ now: () => t });
  const T1 = 't000000000001';
  const T2 = 't000000000002';
  b.applyEvent({ type: 'hello', host: 'old', tab: T1, workspaceFolders: ['/w/a'], chat: { participant: true, defaultParticipant: true, model: true } });
  t += 10;
  b.applyEvent({ type: 'hello', host: 'other', tab: T2, workspaceFolders: ['/w/b'] });
  t += 10;
  b.applyEvent({ type: 'hello', host: 'new', workspaceFolders: ['/w/a'] }); // the reloaded window, before its view said which tab it is
  b.applyEvent({ type: 'tab', tab: T1 }, 'new');
  assert.equal(b.hostForTab(T1), 'new', 'the newest window on the tab');
  assert.equal(b.hostForTab(T2), 'other');
  b.enqueue({ kind: 'openFile', path: '/w/a/x' }, 50, { tab: T1, folder: '/w/a' });
  b.enqueue({ kind: 'openFile', path: '/w/b/y' }, 50, { tab: T2, folder: '/w/b' });
  assert.deepEqual((await b.take(0, undefined, 'old')).map((c) => c.path), [], 'the old host of a reloaded window gets nothing');
  assert.deepEqual((await b.take(0, undefined, 'other')).map((c) => c.path), ['/w/b/y']);
  assert.deepEqual((await b.take(0, undefined, 'new')).map((c) => c.path), ['/w/a/x']);
  // A command for one host waits for that host's poll, and a waiting poll gets it at once.
  const waiting = b.take(1000, undefined, 'other');
  b.enqueue({ kind: 'revealCrewView' }, 50, { host: 'new' });
  b.enqueue({ kind: 'revealCrewView', n: 2 }, 50, { host: 'other' });
  assert.deepEqual((await waiting).map((c) => c.n), [2]);
  assert.equal(b.queue.length, 1);
  // A tab with no window yet: its command waits; a window on its folder that has not said its tab takes it.
  const T3 = 't000000000003';
  b.enqueue({ kind: 'openFile', path: '/w/c/z' }, 50, { tab: T3, folder: '/w/c' });
  assert.deepEqual((await b.take(0, undefined, 'other')).map((c) => c.path), []);
  t += 10;
  b.applyEvent({ type: 'hello', host: 'c', workspaceFolders: ['/w/c/'] });
  assert.deepEqual((await b.take(0, undefined, 'c')).map((c) => c.path), ['/w/c/z']);
  // broadcast: one copy per live window; the theme keeps only the newest per window.
  b.queue.length = 0;
  b.broadcast({ kind: 'applyTheme', theme: { signature: '1' } });
  b.broadcast({ kind: 'applyTheme', theme: { signature: '2' } });
  assert.equal(b.queue.length, 4, 'old, other, new, c');
  assert.deepEqual((await b.take(0, undefined, 'new')).map((c) => c.theme.signature), ['2']);
  // Untargeted commands go to the newest live window only.
  b.queue.length = 0;
  b.enqueue({ kind: 'secretProbe', op: 'get' }, 50);
  assert.deepEqual((await b.take(0, undefined, 'new')).length, 0);
  assert.deepEqual((await b.take(0, undefined, 'c')).map((c) => c.kind), ['secretProbe']);
  // A host that has not polled for a minute is not live: it neither gets broadcasts nor holds tab commands.
  t += 61_000;
  b.seeHost('other');
  assert.equal(b.broadcast({ kind: 'kcChanged' }).length, 1);
  // The per-window editor: /api/state for a tab reports that tab's window.
  b.applyEvent({ type: 'editor', path: '/w/b/y' }, 'other');
  assert.equal(b.snapshot(T2).activeEditor.path, '/w/b/y');
  assert.equal(b.snapshot(T1).activeEditor, null, 'no live window on the tab, so no editor for it');
  b.applyEvent({ type: 'theme', signature: 's', applied: true, changed: false, readBack: { colorTheme: 'Dark Modern', editorBackground: '#000000', count: '3' } });
  assert.deepEqual(b.theme.readBack, { colorTheme: 'Dark Modern', editorBackground: '#000000', count: 3 });
  // A server restart ends every extension host.
  b.resetConnection();
  assert.equal(b.hosts.size, 0);
});

test('buildServerArgs enables proposed API only for well-formed extension ids', () => {
  const args = buildServerArgs({ port: 1234, tokenFile: 't', dataDir: 'd', proposedApiFor: ['kiro-crew.kiro-crew-bridge', 'bad id; rm'] });
  const i = args.indexOf('--enable-proposed-api');
  assert.equal(args[i + 1], 'kiro-crew.kiro-crew-bridge');
  assert.equal(args.filter((a) => a === '--enable-proposed-api').length, 1);
});

test('router: theme and chat status are proxy-signed, bridge chat needs the bridge secret', () => {
  assert.deepEqual(matchRoute('POST', '/api/theme', null), { name: 'theme', auth: 'proxy' });
  assert.deepEqual(matchRoute('GET', '/api/theme', null), { name: 'themeGet', auth: 'proxy' });
  assert.deepEqual(matchRoute('GET', '/api/chat/status', null), { name: 'chatStatus', auth: 'proxy' });
  assert.deepEqual(matchRoute('POST', '/api/chat/ask', null), { name: 'chatAsk', auth: 'proxy' });
  assert.deepEqual(matchRoute('POST', '/api/bridge/chat', null), { name: 'bridgeChat', auth: 'bridge' });
  assert.deepEqual(matchRoute('DELETE', '/api/theme', null), { error: 405 });
  assert.deepEqual(matchRoute('GET', '/vsc-abc/', null), { error: 404 }, 'the API port does not serve the frame');
});

// ---------------------------------------------------------------- two-tier theme (palette / base)

import { resolveTheme, MIN_TEXT_CONTRAST } from '../backend/lib/theme.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

test('resolveTheme tier 1: a sound palette is used', () => {
  const r = resolveTheme(DRACULA);
  assert.equal(r.theme.tier, 'palette');
  assert.equal(r.theme.reason, null);
  const vs = toVsCodeTheme(r.theme);
  assert.equal(vs.tier, 'palette');
  assert.equal(vs.colorTheme, 'Dark Modern');
  assert.ok(Object.keys(vs.colorCustomizations).length > 150);
});

test('resolveTheme tier 2: {kind} alone is valid and gives the stock theme', () => {
  for (const kind of ['dark', 'light']) {
    const r = resolveTheme({ kind });
    assert.deepEqual(r.theme, { kind, vars: null, tier: 'base', reason: 'no palette sent' });
    const vs = toVsCodeTheme(r.theme);
    assert.deepEqual(vs, { colorTheme: kind === 'dark' ? 'Dark Modern' : 'Light Modern', colorCustomizations: {}, tier: 'base' });
  }
  assert.equal(resolveTheme({ kind: 'dark', vars: null }).theme.tier, 'base');
});

test('resolveTheme falls back to tier 2 for missing, malformed or low-contrast vars', () => {
  const cases = [
    [{ kind: 'dark', vars: [] }, /vars must be an object/],
    [{ kind: 'dark', vars: 'x' }, /vars must be an object/],
    [{ kind: 'dark', vars: { '--bg': '#000000' } }, /--text is required/],
    [{ kind: 'dark', vars: { '--bg': '#000000', '--text': 'white' } }, /hex/],
    [{ kind: 'dark', vars: { '--bg': '#000000', '--text': '#ffffff', '--font': '#111111' } }, /unknown variable/],
    [{ kind: 'dark', vars: { '--bg': '#282a36', '--text': '#44475a' } }, /contrast 1\.\d\d:1 is below 4\.5:1/],
    [{ kind: 'light', vars: { '--bg': '#ffffff', '--text': '#999999' } }, /contrast 2\.\d\d:1/],
  ];
  for (const [body, re] of cases) {
    const r = resolveTheme(body);
    assert.equal(r.error, undefined, JSON.stringify(body));
    assert.equal(r.theme.tier, 'base', JSON.stringify(body));
    assert.equal(r.theme.vars, null);
    assert.equal(r.theme.kind, body.kind);
    assert.match(r.theme.reason, re);
  }
  assert.equal(MIN_TEXT_CONTRAST, 4.5);
  // Just above the bar is accepted.
  assert.equal(resolveTheme({ kind: 'light', vars: { '--bg': '#ffffff', '--text': '#767676' } }).theme.tier, 'palette');
});

test('resolveTheme still refuses a broken envelope', () => {
  assert.match(resolveTheme(null).error, /object/);
  assert.match(resolveTheme({}).error, /kind/);
  assert.match(resolveTheme({ kind: 'sepia' }).error, /kind/);
  assert.match(resolveTheme({ kind: 'dark', extra: 1 }).error, /unknown field/);
  assert.match(resolveTheme({ kind: 'dark' }, MAX_THEME_BYTES + 1).error, /bytes/);
});

test('switching palette -> base removes the palette from the seeded settings', () => {
  const palette = toVsCodeTheme(resolveTheme(DRACULA).theme);
  const seeded = seedThemeSettings('{"editor.fontSize": 14}', palette);
  assert.ok(JSON.parse(seeded)['workbench.colorCustomizations']);
  const base = toVsCodeTheme(resolveTheme({ kind: 'light' }).theme);
  const after = JSON.parse(seedThemeSettings(seeded, base));
  assert.equal(after['workbench.colorTheme'], 'Light Modern');
  assert.equal('workbench.colorCustomizations' in after, false, 'no stale palette lingers');
  assert.equal(after['editor.fontSize'], 14);
  assert.notEqual(themeSignature(palette), themeSignature(base));
});

function freePort() {
  return new Promise((ok) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });
}

test('launcher: POST /api/theme moves between tiers, clears the palette and reports the tier', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-tier-'));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, 'backend', 'launcher.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      VSCODE_PANE_ALLOW_UNSIGNED: '1',
      KIROCREW_PROXY_SECRET: '',
      VSCODE_PANE_DATA_DIR: dataDir,
      VSCODE_PANE_SERVER_DIR: path.join(dataDir, 'no-server'),
      VSCODE_PANE_NO_DOWNLOAD: '1',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (body) => fetch(`${base}/api/theme`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const machine = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'server-data', 'data', 'Machine', 'settings.json'), 'utf8'));
  try {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const p1 = await post(DRACULA);
    assert.equal(p1.status, 200);
    assert.equal(p1.json.theme.tier, 'palette');
    assert.ok(machine()['workbench.colorCustomizations']);
    let session = await fetch(`${base}/api/session`).then((r) => r.json());
    assert.deepEqual(session.theme, { kind: 'dark', tier: 'palette' });

    const p2 = await post({ kind: 'dark', vars: { '--bg': '#282a36', '--text': '#2f3140' } });
    assert.equal(p2.status, 200);
    assert.equal(p2.json.changed, true);
    assert.equal(p2.json.theme.tier, 'base');
    assert.match(p2.json.theme.reason, /contrast/);
    assert.equal(machine()['workbench.colorTheme'], 'Dark Modern');
    assert.equal('workbench.colorCustomizations' in machine(), false);
    session = await fetch(`${base}/api/session`).then((r) => r.json());
    assert.deepEqual(session.theme, { kind: 'dark', tier: 'base' });

    const p3 = await post({ kind: 'light' });
    assert.equal(p3.json.theme.tier, 'base');
    assert.equal(machine()['workbench.colorTheme'], 'Light Modern');
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'theme.json'), 'utf8'));
    assert.equal(saved.tier, 'base');
    assert.equal(saved.vars, null);

    assert.equal((await post({ kind: 'dusk' })).status, 400);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
