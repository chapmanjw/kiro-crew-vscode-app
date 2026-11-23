// The app web origin path: a dashboard reached through a Remote Crew tunnel
// cannot use 127.0.0.1:<frame port>, so the workbench loads from
// http://<app>.apps.localhost:<dashboard port>, which the gateway relays here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { isWebOriginHost, upgradeAllowed } from '../backend/lib/frameproxy.mjs';
import { mintAllowed } from '../backend/lib/secretkey.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const coreFile = fs.readdirSync(path.join(ROOT, 'ui')).find((f) => /^vscode-pane-core-.*\.mjs$/.test(f));
const { probeUrl, webOriginUrl, chooseFrameUrl, canUseWebOrigin, chooseReach, frameUrlFor, unreachableAdvice } = await import(pathToFileURL(path.join(ROOT, 'ui', coreFile)).href);

test('the manifest opts into the gateway web origin relay', () => {
  assert.equal(manifest.backend.webOrigin, true);
});

test('isWebOriginHost matches only this app\'s name under apps.localhost', () => {
  assert.equal(isWebOriginHost('vscode-pane.apps.localhost:7778', 'vscode-pane'), true);
  assert.equal(isWebOriginHost('VSCODE-PANE.apps.localhost', 'vscode-pane'), true);
  for (const bad of ['other.apps.localhost:7778', 'vscode-pane.localhost:7778', 'a.vscode-pane.apps.localhost', 'vscode-pane.apps.localhost.evil.example', '127.0.0.1:7778', '', undefined]) {
    assert.equal(isWebOriginHost(bad, 'vscode-pane'), false, String(bad));
  }
});

test('upgradeAllowed on the web origin: no Origin or its own Origin, nothing else', () => {
  const host = 'vscode-pane.apps.localhost:7778';
  const base = { host, listenPort: 5, appName: 'vscode-pane' };
  assert.equal(upgradeAllowed({ ...base, origin: undefined }), true);
  assert.equal(upgradeAllowed({ ...base, origin: `http://${host}` }), true);
  assert.equal(upgradeAllowed({ ...base, origin: 'http://localhost:5476' }), false, 'the dashboard page is not the frame');
  assert.equal(upgradeAllowed({ ...base, origin: 'https://evil.example' }), false);
  // Without the app name the web origin Host is not a loopback Host.
  assert.equal(upgradeAllowed({ host, origin: undefined, listenPort: 5 }), false);
});

test('mintAllowed on the web origin follows the Host it was served under', () => {
  const host = 'vscode-pane.apps.localhost:7778';
  const base = { method: 'POST', host, listenPort: 5, clientHalf: 'x', isLoopbackHost: () => false, isWebOrigin: true };
  assert.deepEqual(mintAllowed({ ...base, origin: `http://${host}` }), { ok: true });
  assert.deepEqual(mintAllowed({ ...base, origin: undefined }), { ok: true });
  assert.equal(mintAllowed({ ...base, origin: 'http://evil.example' }).status, 403);
  assert.equal(mintAllowed({ ...base, origin: `http://${host}`, clientHalf: '' }).status, 403);
  assert.equal(mintAllowed({ ...base, isWebOrigin: false }).status, 403, 'a non-loopback Host is still refused');
});

const session = {
  url: 'http://127.0.0.1:46873/vsc-KEY/?folder=%2Fhome%2Fme',
  webOrigin: { host: 'vscode-pane.apps.localhost', probe: '/_vscp-probe' },
};

test('probeUrl is the frame origin plus the probe path', () => {
  assert.equal(probeUrl(session), 'http://127.0.0.1:46873/_vscp-probe');
  assert.equal(probeUrl({ url: session.url }), null);
  assert.equal(probeUrl(null), null);
});

test('webOriginUrl uses the dashboard\'s own port and the frame URL\'s path and query', () => {
  assert.equal(webOriginUrl(session, { protocol: 'http:', port: '7778' }), 'http://vscode-pane.apps.localhost:7778/vsc-KEY/?folder=%2Fhome%2Fme');
  assert.equal(webOriginUrl(session, { protocol: 'http:', port: '' }), 'http://vscode-pane.apps.localhost/vsc-KEY/?folder=%2Fhome%2Fme');
  assert.equal(webOriginUrl(session, { protocol: 'https:', port: '' }), null, 'only a plain http dashboard');
  assert.equal(webOriginUrl({ url: session.url }, { protocol: 'http:', port: '1' }), null);
});

test('chooseFrameUrl keeps the frame port unless the probe said to use the web origin', () => {
  const loc = { protocol: 'http:', port: '7778' };
  assert.equal(chooseFrameUrl(session, 'frame', loc), session.url);
  assert.equal(chooseFrameUrl(session, 'origin', loc), 'http://vscode-pane.apps.localhost:7778/vsc-KEY/?folder=%2Fhome%2Fme');
  assert.equal(chooseFrameUrl({ url: session.url }, 'origin', loc), null);
  assert.equal(chooseFrameUrl(null, 'frame', loc), null);
});

// A dashboard reached through a tunnel's https address (0.7.1): the frame port is the
// viewer's own 127.0.0.1 and the web origin names the viewer's own loopback, so neither
// leads to the machine that runs Kiro Crew. The page used to point its frame at the
// frame port anyway and show the browser's connection error.
test('canUseWebOrigin: plain http on a loopback name only', () => {
  const at = (protocol, hostname) => ({ protocol, hostname, port: '5476' });
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '[::1]', '::1', 'kirocrew.localhost', 'a-b.localhost']) {
    assert.equal(canUseWebOrigin(at('http:', host)), true, host);
  }
  assert.equal(canUseWebOrigin(at('https:', 'localhost')), false, 'https has no web origin (it is plain http)');
  for (const host of ['tunnel-host.example.test', '192.168.1.5', '10.0.0.7', 'devbox.example.com', 'localhost.evil.example', 'evil.localhost.example', 'a.b.localhost', '', undefined]) {
    assert.equal(canUseWebOrigin(at('http:', host)), false, String(host));
  }
  assert.equal(canUseWebOrigin(null), false);
  assert.equal(canUseWebOrigin({}), false);
  assert.equal(canUseWebOrigin({ protocol: 'http:' }), false, 'no host name, no claim');
});

test('chooseReach: the frame port when it answered, else the web origin when the address can carry it, else none', () => {
  const local = { protocol: 'http:', hostname: '127.0.0.1', port: '5476' };
  const forward = { protocol: 'http:', hostname: 'localhost', port: '49152' };
  const tunnel = { protocol: 'https:', hostname: 'tunnel-host.example.test', port: '' };
  assert.equal(chooseReach(true, local), 'frame');
  assert.equal(chooseReach(true, tunnel), 'frame', 'a probe that answered is the proof, whatever the address');
  assert.equal(chooseReach(false, forward), 'origin');
  assert.equal(chooseReach(false, tunnel), 'none');
  assert.equal(chooseReach(false, { protocol: 'http:', hostname: '192.168.1.5', port: '5476' }), 'none');
});

test('a frame URL for the verdict none is no URL', () => {
  const loc = { protocol: 'https:', hostname: 'x.example', port: '' };
  assert.equal(frameUrlFor(session.url, session, 'none', loc), null);
  assert.equal(chooseFrameUrl(session, 'none', loc), null);
  assert.equal(frameUrlFor(session.url, session, 'frame', loc), session.url, 'the other verdicts are as before');
});

test('unreachableAdvice names the viewer\'s address and the port forward, with the gateway\'s own port', () => {
  const loc = { protocol: 'https:', host: 'tunnel-host.example.test' };
  const a = unreachableAdvice(loc, { webOrigin: { host: 'vscode-pane.apps.localhost', probe: '/_vscp-probe', gatewayPort: 5476 } });
  assert.equal(a.title, 'VS Code cannot load at this address');
  assert.match(a.message, /tunnel-host\.example\.test/);
  assert.equal(a.command, 'ssh -L 5476:127.0.0.1:5476 <user>@<that machine>');
  assert.match(a.steps, /forward a local port/);
  assert.match(a.after, /http:\/\/localhost:5476 in this browser/);
  assert.match(a.after, /kirocrew token/);
  assert.match(a.after, /machine that hosts Kiro Crew itself/);
  // A launcher that does not report its gateway's port (an older run) leaves the port to the reader.
  for (const s of [null, {}, { webOrigin: {} }, { webOrigin: { gatewayPort: null } }, { webOrigin: { gatewayPort: 0 } }, { webOrigin: { gatewayPort: 70000 } }, { webOrigin: { gatewayPort: '5476' } }]) {
    assert.equal(unreachableAdvice(loc, s).command, 'ssh -L <port>:127.0.0.1:<port> <user>@<that machine>', JSON.stringify(s));
  }
  assert.match(unreachableAdvice(null, null).message, /this address/);
});

test('overlayTabBody keeps the tab, its embed path and sign-in state and drops the tunnel address', async () => {
  const { overlayTabBody } = await import('../backend/lib/kctab.mjs');
  const out = overlayTabBody({ available: true, connected: true, origin: 'http://abc.localhost:1', tab: 't0123456789ab', embedPath: '/embed/sessions', embedUrl: 'http://abc.localhost:1/embed/sessions' });
  assert.equal(out.overlay, true);
  assert.equal(out.available, true);
  assert.equal(out.connected, true);
  assert.equal(out.tab, 't0123456789ab');
  assert.equal(out.embedPath, '/embed/sessions');
  for (const k of ['origin', 'embedUrl']) assert.equal(k in out, false, k);
});

test('the chat overlay script: base path and extension id are fixed into it, unsafe values refused', async () => {
  const { overlayScript, injectScriptTag } = await import('../backend/lib/overlay.mjs');
  const js = overlayScript('/vsc-AbC_123');
  assert.match(js, /var BASE = "\/vsc-AbC_123";/);
  assert.match(js, /kiro-crew\.kiro-crew-bridge/);
  assert.match(js, /purpose=webviewview/, 'the tab is found by webview purpose, not by text');
  assert.doesNotThrow(() => new Function(js));
  for (const bad of ['', 'vsc-x', '/vsc x', '/vsc/x', '/vsc-";alert(1);"', null]) assert.throws(() => overlayScript(bad), /bad base path/, String(bad));
  assert.throws(() => overlayScript('/vsc-k', 'a";b'), /bad extension id/);
  assert.equal(injectScriptTag('<html><head><title>x</title></head><body></body></html>', '/vsc-k/_vscp-kc.js'), '<html><head><title>x</title><script defer src="/vsc-k/_vscp-kc.js"></script></head><body></body></html>');
  assert.equal(injectScriptTag('<body></body>', '/vsc-k/a.js'), null);
  assert.throws(() => injectScriptTag('<head></head>', '/a"onload="x'), /unsafe script path/);
});

test('the viewer cookie: partitioned, HttpOnly, and compared in constant time', async () => {
  const { viewerCookieHeader, viewerOk, VIEWER_COOKIE } = await import('../backend/lib/secretkey.mjs');
  const secret = 'A'.repeat(32);
  const header = viewerCookieHeader(secret);
  assert.match(header, new RegExp(`^${VIEWER_COOKIE}=${secret}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned$`));
  assert.throws(() => viewerCookieHeader('bad value;'), /unsafe/);
  assert.equal(viewerOk(`a=1; ${VIEWER_COOKIE}=${secret}; b=2`, secret), true);
  assert.equal(viewerOk(`${VIEWER_COOKIE}=${'B'.repeat(32)}`, secret), false);
  assert.equal(viewerOk(`${VIEWER_COOKIE}=short`, secret), false);
  assert.equal(viewerOk('', secret), false);
  assert.equal(viewerOk(`${VIEWER_COOKIE}=`, ''), false);
});

test('the Kiro Crew view stays an empty placeholder in overlay mode and still shows sign-in', () => {
  const { crewViewHtml, viewMode } = require('../extension/kiro-crew-bridge/crewview.js');
  assert.equal(viewMode({ available: true, overlay: true, embedPath: '/embed/sessions', connected: true }), 'overlay');
  assert.equal(viewMode({ available: true, overlay: true, embedPath: '/embed/sessions', connected: false }), 'signin');
  assert.equal(viewMode({ available: false, overlay: true }), 'unavailable');
  const html = crewViewHtml({ available: true, overlay: true, embedPath: '/embed/sessions', connected: true }, 'N');
  assert.match(html, /data-mode="overlay"/);
  assert.doesNotMatch(html, /<iframe/);
  assert.doesNotMatch(html, /frame-src/);
});

test('the overlay asks the page which tab it is, then frames only an embed path the launcher names', async () => {
  const { overlayScript } = await import('../backend/lib/overlay.mjs');
  const { EMBED_PATH_RE } = await import('../backend/lib/kctab.mjs');
  const js = overlayScript('/vsc-k');
  assert.match(js, /new URLSearchParams\(location\.search\)\.get\('vscpTab'\)/, 'the window\'s own ?vscpTab= first');
  assert.match(js, /window\.parent\.postMessage\(\{ vscodePane: 'tab\?', nonce: nonce \}, '\*'\)/);
  assert.match(js, /e\.source === window\.parent && d && d\.vscodePane === 'tab' && d\.nonce === nonce/, 'only the page that holds this window answers');
  assert.match(js, /\/_vscp-kc\/state' \+ \(tab \? '\?tab=' \+ encodeURIComponent\(tab\) : ''\)/);
  assert.ok(js.includes(`var EMBED = ${EMBED_PATH_RE.toString()};`));
  assert.match(js, /embed = typeof s\.embed === 'string' && EMBED\.test\(s\.embed\) \? s\.embed : ''/);
  assert.doesNotMatch(js, /opened=|folder=/, 'nothing in Kiro Crew is created from here');
});
