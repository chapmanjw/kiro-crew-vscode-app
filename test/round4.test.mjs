// Round 4 (0.5.0): the workbench's secret-storage key (backend/lib/secretkey.mjs
// and the frame proxy), the "Kiro Crew" view in VS Code's secondary side bar
// (extension package.json, backend/lib/crewview.mjs, backend/lib/view-overlay.js)
// and the page's overlay helpers (ui/vscode-pane-crew-core-*.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  KEY_BYTES, MINT_PATH, decodeKeyPart, encodeKeyPart, mintKey, readCookie, clientHalfFrom, secretCookies, loadServerHalf, mintAllowed, restrictToUser,
} from '../backend/lib/secretkey.mjs';
import { createFrameProxy, injectOverlayScript, isLoopbackHost } from '../backend/lib/frameproxy.mjs';
import { parseCrewViewRequest, parseSecretProbe, CREW_VIEW_HOMES } from '../backend/lib/crewview.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const ext = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'kiro-crew-bridge', 'package.json'), 'utf8'));
const pick = (re) => fs.readdirSync(UI).find((f) => re.test(f));
const crewCoreFile = pick(/^vscode-pane-crew-core-.*\.mjs$/);
const crewFile = pick(/^vscode-pane-crew-\d.*\.mjs$/);
const core = await import(pathToFileURL(path.join(UI, crewCoreFile)).href);
const pageSrc = fs.readFileSync(path.join(UI, manifest.ui.entry), 'utf8');
const crewSrc = fs.readFileSync(path.join(UI, crewFile), 'utf8');

// ------------------------------------------------------------ secret key

test('key parts are 32 bytes, base64url, as serve-web encodes them', () => {
  const b = crypto.randomBytes(KEY_BYTES);
  const s = encodeKeyPart(b);
  assert.match(s, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(decodeKeyPart(s).equals(b));
  assert.ok(decodeKeyPart(s + '=').equals(b), 'padded form (Rust URL_SAFE) is read too');
  for (const bad of ['', 'abc', 'A'.repeat(42), 'A'.repeat(44), '!'.repeat(43), null, 5]) assert.equal(decodeKeyPart(bad), null, String(bad));
});

test('mintKey is sha256(server half || client half), as serve_web.rs handle_secret_mint', () => {
  const a = crypto.randomBytes(32);
  const b = crypto.randomBytes(32);
  const want = crypto.createHash('sha256').update(Buffer.concat([a, b])).digest();
  assert.ok(mintKey(a, b).equals(want));
  assert.equal(mintKey(a, b).length, 32);
  assert.ok(!mintKey(a, b).equals(mintKey(b, a)));
});

test('cookies: the path cookie is readable, the half HttpOnly; both work in a cross-site frame', () => {
  const half = crypto.randomBytes(32);
  const [p, c] = secretCookies(half);
  assert.equal(MINT_PATH, '/_vscode-cli/mint-key');
  assert.match(p, /^vscode-secret-key-path=\/_vscode-cli\/mint-key; /);
  assert.doesNotMatch(p, /HttpOnly/);
  assert.equal(c.split(';')[0], `vscode-cli-secret-half=${encodeKeyPart(half)}`);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Max-Age=34560000/);
  for (const v of [p, c]) {
    assert.match(v, /SameSite=None/);
    assert.match(v, /; Secure/);
    assert.match(v, /Partitioned/);
    assert.match(v, /Path=\//);
  }
  // A new half when the browser has none (or a malformed one).
  const fresh = secretCookies(null)[1].split(';')[0].split('=')[1];
  assert.ok(decodeKeyPart(fresh));
  assert.notEqual(fresh, encodeKeyPart(half));
});

test('readCookie and clientHalfFrom pick the right cookie out of a header', () => {
  const half = encodeKeyPart(crypto.randomBytes(32));
  const header = `a=1; vscode-cli-secret-half=${half}; vscode-cli-secret-half-x=nope`;
  assert.equal(readCookie(header, 'a'), '1');
  assert.equal(readCookie(header, 'missing'), '');
  assert.equal(encodeKeyPart(clientHalfFrom(header)), half);
  assert.equal(clientHalfFrom('vscode-cli-secret-half=short'), null);
  assert.equal(clientHalfFrom(undefined), null);
});

test('loadServerHalf creates the half once, keeps it, and replaces a malformed file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-key-'));
  const file = path.join(dir, 'state', 'secret-key-half');
  let restricted = 0;
  const first = loadServerHalf(file, { restrict: () => (restricted++, true) });
  assert.equal(first.created, true);
  assert.equal(first.key.length, 32);
  assert.equal(restricted, 1);
  assert.match(fs.readFileSync(file, 'utf8'), /^[A-Za-z0-9_-]{43}\n$/);
  const again = loadServerHalf(file, { restrict: () => (restricted++, true) });
  assert.equal(again.created, false);
  assert.ok(again.key.equals(first.key));
  assert.equal(restricted, 1);
  fs.writeFileSync(file, 'garbage');
  const replaced = loadServerHalf(file, { restrict: () => true });
  assert.equal(replaced.created, true);
  assert.ok(!replaced.key.equals(first.key));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restrictToUser leaves only the current user on the file (Windows ACL or POSIX 0600)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-acl-'));
  const file = path.join(dir, 'k');
  fs.writeFileSync(file, 'x');
  assert.equal(restrictToUser(file), true);
  if (process.platform === 'win32') {
    const out = String(require_icacls(file));
    const aces = out.split(/\r?\n/).map((l) => l.replace(file, '').trim()).filter((l) => /:\(/.test(l));
    assert.equal(aces.length, 1, out);
    assert.match(aces[0], new RegExp(`${os.userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\(F\\)$`, 'i'));
  } else {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function require_icacls(file) {
  return execFileSync('icacls', [file], { encoding: 'utf8', windowsHide: true });
}

test('mintAllowed: POST, loopback Host, frame origin or none, and a client half', () => {
  const half = crypto.randomBytes(32);
  const base = { method: 'POST', host: '127.0.0.1:4000', origin: 'http://127.0.0.1:4000', listenPort: 4000, clientHalf: half, isLoopbackHost };
  assert.deepEqual(mintAllowed(base), { ok: true });
  assert.deepEqual(mintAllowed({ ...base, origin: undefined }), { ok: true });
  assert.equal(mintAllowed({ ...base, method: 'GET' }).status, 405);
  assert.equal(mintAllowed({ ...base, host: 'evil.example' }).status, 403);
  assert.equal(mintAllowed({ ...base, origin: 'http://localhost:5476' }).status, 403, 'the dashboard page itself may not mint');
  assert.equal(mintAllowed({ ...base, origin: 'https://evil.example' }).status, 403);
  assert.equal(mintAllowed({ ...base, clientHalf: null }).status, 403);
});

// ------------------------------------------------------------ frame proxy

const WORKBENCH = `<!doctype html><html><head><meta id="vscode-workbench-web-configuration" data-settings="{&quot;remoteAuthority&quot;:&quot;x&quot;}"><title>wb</title></head><body></body></html>`;

function upstream(html, headers = {}) {
  const srv = http.createServer((req, res) => {
    if (req.url.includes('/asset')) {
      res.writeHead(200, { 'content-type': 'text/css' });
      return res.end('body{}');
    }
    res.writeHead(200, { 'content-type': 'text/html', ...headers });
    res.end(html);
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

test('injectOverlayScript adds one same-origin script before </head> and refuses an unsafe path', () => {
  const out = injectOverlayScript(WORKBENCH, '/vsc-abc/_kiro-crew/view-overlay.js');
  assert.match(out, /<script src="\/vsc-abc\/_kiro-crew\/view-overlay\.js"><\/script>\n<\/head>/);
  assert.equal(injectOverlayScript('<html><body></body></html>', '/x.js'), '<html><body></body></html>');
  assert.throws(() => injectOverlayScript(WORKBENCH, '"><script>alert(1)</script>'));
  assert.throws(() => injectOverlayScript(WORKBENCH, 'https://evil.example/x.js'));
});

test('the proxy sets the secret cookies and the overlay script on the workbench page only, and serves the script', async () => {
  const up = await upstream(WORKBENCH, { 'set-cookie': ['vscode-tkn=t0k3n; Path=/', 'other=1'] });
  const proxy = createFrameProxy(() => ({ port: up.address().port, token: 't0k3n' }), {
    overlayScriptPath: '/vsc-k/_kiro-crew/view-overlay.js', overlayScript: () => '/* overlay */', secretKey: true,
  });
  const srv = http.createServer(proxy.handleRequest);
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = srv.address().port;
  try {
    const half = encodeKeyPart(crypto.randomBytes(32));
    const page = await get(port, '/vsc-k/', { cookie: `vscode-cli-secret-half=${half}` });
    assert.equal(page.status, 200);
    assert.match(page.body, /<script src="\/vsc-k\/_kiro-crew\/view-overlay\.js"><\/script>/);
    assert.match(page.body, /&quot;connectionToken&quot;:&quot;t0k3n&quot;/);
    const sc = page.headers['set-cookie'];
    assert.ok(!sc.some((c) => c.startsWith('vscode-tkn=')), 'the token cookie is still dropped');
    assert.ok(sc.includes('other=1'));
    assert.ok(sc.some((c) => c.startsWith('vscode-secret-key-path=/_vscode-cli/mint-key;')));
    assert.ok(sc.some((c) => c.startsWith(`vscode-cli-secret-half=${half};`)), 'the half the browser has is kept');
    const fresh = await get(port, '/vsc-k/');
    const newHalf = fresh.headers['set-cookie'].find((c) => c.startsWith('vscode-cli-secret-half=')).split(';')[0].split('=')[1];
    assert.ok(decodeKeyPart(newHalf) && newHalf !== half, 'a browser without a half gets a new one');
    const asset = await get(port, '/vsc-k/asset.css');
    assert.equal(asset.headers['set-cookie'], undefined, 'no cookies on assets');
    const script = await get(port, '/vsc-k/_kiro-crew/view-overlay.js');
    assert.equal(script.status, 200);
    assert.equal(script.body, '/* overlay */');
    assert.match(script.headers['content-type'], /^text\/javascript/);
    assert.equal(script.headers['cache-control'], 'no-store');
  } finally {
    srv.close();
    up.close();
  }
});

// ------------------------------------------------------------ the view and its routes

test('the bridge contributes a "Kiro Crew" webview view to the secondary side bar, opened by Ctrl+Alt+K', () => {
  const c = ext.contributes;
  assert.equal(ext.version, manifest.version);
  assert.deepEqual(c.viewsContainers.secondarySidebar.map((v) => v.id), ['kiroCrew']);
  assert.equal(c.viewsContainers.secondarySidebar[0].title, 'Kiro Crew');
  assert.ok(fs.existsSync(path.join(ROOT, 'extension', 'kiro-crew-bridge', c.viewsContainers.secondarySidebar[0].icon)));
  assert.deepEqual(c.views.kiroCrew.map((v) => [v.type, v.id, v.name]), [['webview', 'kiroCrew.chatView', 'Kiro Crew']]);
  assert.deepEqual(c.keybindings, [{ command: 'kiroCrew.openCrewChat', key: 'ctrl+alt+k', mac: 'cmd+alt+k' }]);
  assert.ok(c.commands.some((x) => x.command === 'kiroCrew.openCrewChat'));
  assert.ok(c.commands.some((x) => x.command === 'kiroCrew.toggleCrewChat'), 'the 0.4.0 id still runs');
  assert.equal(CREW_VIEW_HOMES.auxiliarybar, `workbench.view.extension.${c.viewsContainers.secondarySidebar[0].id}`);
  const src = fs.readFileSync(path.join(ROOT, 'extension', 'kiro-crew-bridge', 'extension.js'), 'utf8');
  assert.match(src, /registerWebviewViewProvider\(CREW_VIEW_ID/);
  assert.match(src, /const CREW_CONTAINER_ID = 'workbench\.view\.extension\.kiroCrew'/);
  assert.match(src, /retainContextWhenHidden: true/);
});

test('POST /api/crew/view and /api/secret-probe bodies', () => {
  assert.deepEqual(parseCrewViewRequest({ action: 'reveal' }), { command: { kind: 'revealCrewView' } });
  assert.deepEqual(parseCrewViewRequest({ action: 'move', to: 'panel' }), { command: { kind: 'moveCrewView', to: 'panel', container: 'workbench.panel.output' } });
  for (const bad of [null, [], {}, { action: 'move', to: 'window' }, { action: 'move', to: '__proto__' }, { action: 'run', command: 'x' }]) assert.ok(parseCrewViewRequest(bad).error, JSON.stringify(bad));
  assert.deepEqual(parseSecretProbe({ op: 'get' }), { command: { kind: 'secretProbe', op: 'get' } });
  assert.deepEqual(parseSecretProbe({ op: 'set', value: 'abc' }), { command: { kind: 'secretProbe', op: 'set', value: 'abc' } });
  for (const bad of [{ op: 'set' }, { op: 'set', value: '' }, { op: 'set', value: 'x'.repeat(201) }, { op: 'set', value: 'a\nb' }, { op: 'del' }]) assert.ok(parseSecretProbe(bad).error, JSON.stringify(bad));
});

test('the view-overlay script finds the view by extension id and purpose, posts only to the hello origin and reacts to change only', () => {
  const s = fs.readFileSync(path.join(ROOT, 'backend', 'lib', 'view-overlay.js'), 'utf8');
  assert.match(s, /var EXT = 'kiro-crew\.kiro-crew-bridge'/);
  assert.match(s, /purpose'\) === 'webviewView'/);
  assert.match(s, /window\.parent\.postMessage\(report, st\.parentOrigin\)/);
  assert.match(s, /if \(e\.source !== window\.parent\) return;/);
  assert.match(s, /new ResizeObserver\(schedule\)/);
  assert.match(s, /new MutationObserver\(/);
  assert.doesNotMatch(s, /setInterval/);
  // The only '*' post is the data-free ready ping.
  const stars = [...s.matchAll(/postMessage\(([^)]*), '\*'\)/g)].map((m) => m[1]);
  assert.deepEqual(stars, ["{ type: 'kc-view-ready' }"]);
  for (const sel of ['.quick-input-widget', '.context-view', '.monaco-dialog-modal-block', '.notifications-toasts.visible', '.notifications-center.visible', '.workbench-hover']) assert.ok(s.includes(sel), sel);
  assert.match(s, /dragstart/);
});

// ------------------------------------------------------------ overlay helpers

const { acceptViewMessage, isReadyMessage, hiddenReason, overlayPlacement, shouldForwardKey, keyPayload, newNonce, frameOrigin, chipHideCss, CHIP_ICON } = core;

test('crew files carry the same version as the page entry; no docked column left', () => {
  const v = /-(\d+\.\d+\.\d+)\.mjs$/.exec(manifest.ui.entry)[1];
  assert.equal(crewCoreFile, `vscode-pane-crew-core-${v}.mjs`);
  assert.equal(crewFile, `vscode-pane-crew-${v}.mjs`);
  for (const gone of ['CrewColumn', 'crewChatToggle', 'clampCrewWidth', 'vscode-pane-crew-sash']) {
    assert.ok(!pageSrc.includes(gone) && !crewSrc.includes(gone), gone);
  }
  assert.match(pageSrc, /h\(CrewOverlay, \{ api, session, folder, kind, overlayRef: crewRef, mountPanel: crewMounted \}\)/);
  assert.match(crewSrc, /h\(Panel, \{ key: slotKey, slotKey, conversationOnly: true \}\)/);
});

function msg(over = {}) {
  const win = {};
  const nonce = 'n'.repeat(32);
  return {
    win,
    nonce,
    event: {
      origin: 'http://127.0.0.1:4000', source: win,
      data: { type: 'kc-view', nonce, seq: 4, view: { found: true, visible: true, rect: { x: 10, y: 20, width: 300, height: 600 }, location: 'auxiliarybar', focused: false }, blocked: [], dragging: false, viewport: { w: 1300, h: 800 }, hidden: false, ...over },
    },
  };
}

test('acceptViewMessage takes only the frame origin, its window and the nonce', () => {
  const { win, nonce, event } = msg();
  const ctx = { origin: 'http://127.0.0.1:4000', source: win, nonce };
  const r = acceptViewMessage(event, ctx);
  assert.deepEqual(r.view, { found: true, visible: true, rect: { x: 10, y: 20, width: 300, height: 600 }, location: 'auxiliarybar', focused: false });
  assert.equal(r.seq, 4);
  assert.equal(acceptViewMessage({ ...event, origin: 'http://localhost:5476' }, ctx), null, 'wrong origin');
  assert.equal(acceptViewMessage({ ...event, source: {} }, ctx), null, 'another window');
  assert.equal(acceptViewMessage({ ...event, data: { ...event.data, nonce: 'x'.repeat(32) } }, ctx), null, 'wrong nonce');
  assert.equal(acceptViewMessage({ ...event, data: { ...event.data, nonce: undefined } }, ctx), null, 'no nonce');
  assert.equal(acceptViewMessage(event, { ...ctx, nonce: '' }), null, 'no nonce of our own yet');
  assert.equal(acceptViewMessage({ ...event, data: 'kc-view' }, ctx), null);
  // Malformed fields are dropped, not trusted.
  const odd = acceptViewMessage(msg({ view: { found: true, visible: true, rect: { x: 'a' } }, blocked: ['quickInput', '<img>'], viewport: { w: -1 } }).event, ctx);
  assert.equal(odd, null, 'another window (each msg() has its own source)');
  const { event: e2, win: w2, nonce: n2 } = msg({ view: { found: true, visible: true, rect: { x: 'a' }, location: 'x' }, blocked: ['quickInput', '<img>'], viewport: { w: -1, h: 3 } });
  const r2 = acceptViewMessage(e2, { origin: 'http://127.0.0.1:4000', source: w2, nonce: n2 });
  assert.equal(r2.view.visible, false, 'no usable rect means not visible');
  assert.equal(r2.view.location, 'unknown');
  assert.deepEqual(r2.blocked, ['quickInput']);
  assert.equal(r2.viewport, null);
  assert.equal(isReadyMessage({ origin: 'http://127.0.0.1:4000', source: win, data: { type: 'kc-view-ready' } }, ctx), true);
  assert.equal(isReadyMessage({ origin: 'http://evil', source: win, data: { type: 'kc-view-ready' } }, ctx), false);
});

test('hiddenReason: view hidden, covered by a VS Code popup, a drag, or a hidden document', () => {
  const { win, nonce, event } = msg();
  const ctx = { origin: 'http://127.0.0.1:4000', source: win, nonce };
  assert.equal(hiddenReason(null), 'no report');
  assert.equal(hiddenReason(acceptViewMessage(event, ctx)), '');
  const with_ = (over) => acceptViewMessage({ ...event, data: { ...event.data, ...over } }, ctx);
  assert.equal(hiddenReason(with_({ blocked: ['quickInput', 'notification'] })), 'covered by quickInput, notification');
  assert.equal(hiddenReason(with_({ dragging: true })), 'drag');
  assert.equal(hiddenReason(with_({ view: { found: true, visible: false } })), 'view hidden');
  assert.equal(hiddenReason(with_({ view: { found: false } })), 'view not created');
  assert.equal(hiddenReason(with_({ hidden: true })), 'document hidden');
});

test('overlayPlacement maps the view through the iframe box, scales for zoom and clips to the bounds', () => {
  const iframe = { left: 100, top: 50, width: 1300, height: 800 };
  const p = overlayPlacement({ x: 1000, y: 30, width: 300, height: 770 }, { w: 1300, h: 800 }, iframe, { left: 0, top: 0, width: 2000, height: 2000 });
  assert.deepEqual(p, { left: 1100, top: 80, width: 300, height: 770, clip: 'inset(0px 0px 0px 0px)' });
  // The frame drawn at 1.25x its CSS viewport (a zoomed iframe): everything scales.
  const z = overlayPlacement({ x: 800, y: 24, width: 240, height: 616 }, { w: 1040, h: 640 }, iframe, null);
  assert.deepEqual([z.left, z.top, z.width, z.height], [1100, 80, 300, 770]);
  // <main> cut off at y=600: the overlay is clipped, not moved.
  const c = overlayPlacement({ x: 1000, y: 30, width: 300, height: 770 }, { w: 1300, h: 800 }, iframe, { left: 0, top: 0, width: 2000, height: 600 });
  assert.equal(c.clip, 'inset(0px 0px 250px 0px)');
  assert.equal(overlayPlacement({ x: 0, y: 0, width: 10, height: 10 }, { w: 1300, h: 800 }, iframe, { left: 0, top: 0, width: 50, height: 50 }), null);
  assert.equal(overlayPlacement(null, null, iframe, null), null);
});

test('shouldForwardKey sends VS Code chords and F-keys, keeps typing and editing keys in the chat', () => {
  const k = (key, mods = {}) => ({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, getModifierState: () => false, ...mods });
  for (const e of [k('F1'), k('P', { ctrlKey: true, shiftKey: true }), k('p', { ctrlKey: true }), k('k', { ctrlKey: true, altKey: true }), k('b', { ctrlKey: true, altKey: true }), k('`', { ctrlKey: true }), k('j', { metaKey: true })]) {
    assert.equal(shouldForwardKey(e), true, JSON.stringify(e));
  }
  for (const e of [k('a'), k('Enter'), k('Escape'), k('c', { ctrlKey: true }), k('v', { ctrlKey: true }), k('z', { ctrlKey: true }), k('Z', { ctrlKey: true, shiftKey: true }),
    k('ArrowLeft', { ctrlKey: true }), k('Backspace', { ctrlKey: true }), k('Enter', { ctrlKey: true }), k('ArrowUp', { altKey: true }), k('Control', { ctrlKey: true }),
    k('p', { ctrlKey: true, defaultPrevented: true }), k('@', { ctrlKey: true, altKey: true, getModifierState: (m) => m === 'AltGraph' })]) {
    assert.equal(shouldForwardKey(e), false, JSON.stringify(e));
  }
  assert.deepEqual(keyPayload({ key: 'P', code: 'KeyP', keyCode: 80, ctrlKey: true, shiftKey: true }), { key: 'P', code: 'KeyP', keyCode: 80, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false });
});

test('nonce and frame origin', () => {
  const a = newNonce();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, newNonce());
  assert.equal(frameOrigin('http://127.0.0.1:4000/vsc-abc/?folder=x'), 'http://127.0.0.1:4000');
  assert.equal(frameOrigin('nope'), '');
});

test('the chip-hiding CSS is scoped to the overlay and matches the manifest chip by its icon class', () => {
  assert.equal(CHIP_ICON, manifest.contributes.sessionControls[0].icon);
  const css = chipHideCss('.vscp-crew-overlay');
  for (const line of css.split('\n')) assert.ok(line.startsWith('.vscp-crew-overlay '), line);
  assert.match(css, /button\[data-session-control-chip\]:has\(svg\.lucide-package\)\{display:none !important\}/);
  assert.match(chipHideCss('.x', 'AudioLines'), /lucide-audio-lines/);
  assert.doesNotMatch(css, /VS Code|aria-label|title/, 'never by text');
  assert.throws(() => chipHideCss('body div'));
  assert.match(crewSrc, /\$\{chipHideCss\('\.' \+ ROOT_CLASS\)\}/);
});
