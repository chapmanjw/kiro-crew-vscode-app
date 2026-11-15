// Round 4 (0.5.0): the workbench's secret-storage key (backend/lib/secretkey.mjs
// and the frame proxy), the self-hosted webview endpoint, and the "Kiro Crew"
// view in VS Code's secondary side bar (extension package.json and crewview.js,
// backend/lib/crewview.mjs, kctab.mjs, chipcss.mjs). The tunnel itself is in
// test/kcproxy.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  KEY_BYTES, MINT_PATH, decodeKeyPart, encodeKeyPart, mintKey, readCookie, clientHalfFrom, secretCookies, loadServerHalf, mintAllowed, restrictToUser,
} from '../backend/lib/secretkey.mjs';
import { createFrameProxy, injectWebviewEndpoint, isLoopbackHost } from '../backend/lib/frameproxy.mjs';
import { parseCrewViewRequest, parseSecretProbe, CREW_VIEW_HOMES } from '../backend/lib/crewview.mjs';
import { crewSlotRequest, dashboardOrigins } from '../backend/lib/kctab.mjs';
import { chipHideCss, CHIP_ICON } from '../backend/lib/chipcss.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UI = path.join(ROOT, 'ui');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const ext = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'kiro-crew-bridge', 'package.json'), 'utf8'));
const pageSrc = fs.readFileSync(path.join(UI, manifest.ui.entry), 'utf8');
const VIEW = path.join(ROOT, 'extension', 'kiro-crew-bridge', 'crewview.js');
const crewview = Module.createRequire(VIEW)(VIEW);

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

test('injectWebviewEndpoint points webviews at <uuid>.localhost on the frame port, under the static route', () => {
  const html = WORKBENCH.replace('</head>', '<script type="module" src="/vsc-k/stable-abc123/static/out/vs/code/browser/workbench/workbench.js"></script></head>');
  const out = injectWebviewEndpoint(html, 4123);
  assert.ok(out.includes('&quot;webviewEndpoint&quot;:&quot;http://{{uuid}}.localhost:4123/vsc-k/stable-abc123/static/out/vs/workbench/contrib/webview/browser/pre/&quot;,'));
  assert.equal(injectWebviewEndpoint(WORKBENCH, 4123), null, 'no workbench.js, no endpoint');
  assert.throws(() => injectWebviewEndpoint(html, 0));
  assert.equal(isLoopbackHost('0a1b2c.localhost:4123'), true, 'webview origins are <uuid>.localhost');
  assert.equal(isLoopbackHost('evil.example:4123'), false);
  assert.equal(isLoopbackHost('a.b.localhost'), false, 'one label only');
});

test('the proxy sets the secret cookies and the webview endpoint on the workbench page only', async () => {
  const html = WORKBENCH.replace('</head>', '<script type="module" src="/vsc-k/stable-c/static/out/vs/code/browser/workbench/workbench.js"></script></head>');
  const up = await upstream(html, { 'set-cookie': ['vscode-tkn=t0k3n; Path=/', 'other=1'] });
  const proxy = createFrameProxy(() => ({ port: up.address().port, token: 't0k3n' }), { webviewPort: () => 4555, secretKey: true });
  const srv = http.createServer(proxy.handleRequest);
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = srv.address().port;
  try {
    const half = encodeKeyPart(crypto.randomBytes(32));
    const page = await get(port, '/vsc-k/', { cookie: `vscode-cli-secret-half=${half}` });
    assert.equal(page.status, 200);
    assert.match(page.body, /&quot;webviewEndpoint&quot;:&quot;http:\/\/\{\{uuid\}\}\.localhost:4555\/vsc-k\/stable-c\/static\//);
    assert.match(page.body, /&quot;connectionToken&quot;:&quot;t0k3n&quot;/);
    assert.doesNotMatch(page.body, /view-overlay/, 'no overlay script any more');
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
  assert.ok(c.commands.some((x) => x.command === 'kiroCrew.disconnect'), 'Disconnect command');
  assert.ok(c.commands.some((x) => x.command === 'kiroCrew.connect'));
  assert.deepEqual(c.menus['view/title'].map((m) => m.command), ['kiroCrew.disconnect']);
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

test('the view frames /embed/chat/<slot> on the tunnel origin only, with a CSP that allows only that frame', () => {
  const origin = `http://${'a'.repeat(32)}.localhost:41234`;
  const kc = { available: true, connected: true, origin, slot: 'vscode-my-folder-0123456789' };
  const html = crewview.crewViewHtml(kc, 'n0nce');
  assert.equal(crewview.viewMode(kc), 'frame');
  assert.match(html, new RegExp(`<iframe id="kc" title="Kiro Crew" src="${origin}/embed/chat/vscode-my-folder-0123456789"`));
  assert.match(html, new RegExp(`default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-n0nce'; frame-src ${origin}"`));
  // Not signed in: Connect and paste, no frame.
  const signin = crewview.crewViewHtml({ ...kc, connected: false, lastError: '<b>x</b>' }, 'n');
  assert.equal(crewview.viewMode({ ...kc, connected: false }), 'signin');
  assert.doesNotMatch(signin, /<iframe/);
  assert.match(signin, /id="connect"/);
  assert.match(signin, /id="paste"/);
  assert.match(signin, /&lt;b&gt;x&lt;\/b&gt;/, 'errors are escaped');
  // Anything but the exact tunnel origin shape is not framed.
  for (const bad of ['http://localhost:5476', `https://${'a'.repeat(32)}.localhost:1`, `http://${'a'.repeat(32)}.localhost:1/x`, 'javascript:alert(1)']) {
    assert.equal(crewview.viewMode({ ...kc, origin: bad }), 'unavailable', bad);
    assert.doesNotMatch(crewview.crewViewHtml({ ...kc, origin: bad }, 'n'), /<iframe/);
  }
  assert.equal(crewview.viewMode({ ...kc, slot: '' }), 'nofolder');
});

test('S-3: the folder slot is created only when the tab opens, for an absolute existing folder the window has open', () => {
  const roots = ['C:\\w\\proj'];
  const base = { roots, isAbsolute: path.win32.isAbsolute, exists: (f) => f.startsWith('C:\\w\\'), inRoots: (f, r) => r.some((x) => f.toLowerCase().startsWith(x.toLowerCase())) };
  assert.deepEqual(crewSlotRequest({ ...base, folder: 'C:\\w\\proj', opened: true }), { folder: 'C:\\w\\proj', ensure: true });
  assert.deepEqual(crewSlotRequest({ ...base, folder: 'C:\\w\\proj', opened: false }), { folder: 'C:\\w\\proj', ensure: false }, 'a poll only names it');
  assert.ok(crewSlotRequest({ ...base, folder: 'relative\\proj', opened: true }).error);
  assert.ok(crewSlotRequest({ ...base, folder: 'C:\\gone\\proj', opened: true }).error, 'must exist');
  assert.ok(crewSlotRequest({ ...base, folder: 'C:\\w\\other', opened: true }).error, 'must be open in the window');
  assert.ok(crewSlotRequest({ ...base, folder: undefined, opened: true }).error);
  // GET /api/session no longer creates the slot (it only names it).
  const launcher = fs.readFileSync(path.join(ROOT, 'backend', 'launcher.mjs'), 'utf8');
  const sessionFn = launcher.slice(launcher.indexOf('function sessionBody('), launcher.indexOf('function chatProblem('));
  assert.doesNotMatch(sessionFn, /ensureCrewSlot|ensureSlot/);
});

test('dashboardOrigins: the gateway origin in both loopback spellings, plus the override; nothing else', () => {
  assert.deepEqual(dashboardOrigins({ KIROCREW_GATEWAY_ORIGIN: 'http://localhost:5476' }).sort(), ['http://127.0.0.1:5476', 'http://localhost:5476']);
  assert.deepEqual(dashboardOrigins({ KIROCREW_GATEWAY_ORIGIN: 'http://127.0.0.1:5476/', VSCODE_PANE_DASHBOARD_ORIGIN: 'http://localhost:9000, https://evil.example, http://evil.example:1' }).sort(),
    ['http://127.0.0.1:5476', 'http://127.0.0.1:9000', 'http://localhost:5476', 'http://localhost:9000']);
  assert.deepEqual(dashboardOrigins({}), []);
});

test('the chip-hiding CSS matches the manifest chip by its icon class, never by text', () => {
  assert.equal(CHIP_ICON, manifest.contributes.sessionControls[0].icon);
  const css = chipHideCss();
  // V5 S-6: our chip only, by its label and icon; another app's Package chip is kept.
  assert.equal(manifest.contributes.sessionControls[0].label, 'VS Code');
  assert.ok(!('statusPath' in manifest.contributes.sessionControls[0]), 'no status, so the aria-label is the label alone');
  assert.match(css, /^button\[data-session-control-chip\]\[aria-label="VS Code"\]:has\(svg\.lucide-package\)\{display:none !important\}/);
  assert.throws(() => chipHideCss('Package', 'x"]{}'));
  assert.match(chipHideCss('AudioLines'), /lucide-audio-lines/);
  assert.doesNotMatch(css, /title=/);
});

test('the page has no overlay or docked column; it signs the tunnel in with the dashboard session', () => {
  for (const gone of ['CrewOverlay', 'CrewColumn', 'crewChatToggle', 'kc-view', 'overlayPlacement', 'vscode-pane-crew-sash']) assert.ok(!pageSrc.includes(gone), gone);
  assert.ok(!fs.readdirSync(UI).some((f) => /^vscode-pane-crew-/.test(f)), 'the crew modules are gone');
  assert.ok(!fs.existsSync(path.join(ROOT, 'backend', 'lib', 'view-overlay.js')));
  assert.match(pageSrc, /fetch\('\/api\/auth\/mobile-link', \{ method: 'POST', credentials: 'same-origin'/);
  assert.match(pageSrc, /api\.post\(`\$\{API\}\/kc\/sign-in`, \{ url: j\.url, via \}\)/);
});
