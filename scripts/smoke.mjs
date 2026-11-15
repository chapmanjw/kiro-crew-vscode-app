#!/usr/bin/env node
// End-to-end smoke test for the vscode-pane launcher, run standalone (no
// Kiro Crew gateway). It plays the gateway's part: sets PORT and
// KIROCREW_PROXY_SECRET, signs /api calls like the proxy, and stops the
// backend with a Windows tree kill like the gateway does.
//
//   node scripts/smoke.mjs [--keep] [--server-dir <path>]
//
// Needs a VS Code server build (default: the R1-B probe's copy under .cache)
// and a local Chrome or Edge for the headless workbench.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signProxyRequest } from '../backend/lib/auth.mjs';
import { loadPlaywright, findBrowser } from './lib/browser.mjs';
import { createDashboardStandin } from './lib/dashboard-standin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
// --minimal-env starts the launcher with only the variables the Kiro Crew
// gateway passes to app backends (kiro_crew/apps/registry_pipeline/
// subprocess_env.py, _SAFE_ENV_KEYS), like a real install.
const MINIMAL_ENV = argv.includes('--minimal-env');
const GATEWAY_SAFE_ENV = new Set([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'APPDATA', 'COMSPEC',
  'LOCALAPPDATA', 'PATHEXT', 'PROGRAMDATA', 'PROGRAMFILES', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  'JAVA_HOME', 'NODE_PATH', 'NVM_DIR', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_DEFAULT_ENV', 'CONDA_PREFIX', 'ANT_HOME',
  'GRADLE_USER_HOME', 'MAVEN_OPTS', 'GIT_SSH', 'GIT_SSH_COMMAND',
]);
function launcherBaseEnv() {
  if (!MINIMAL_ENV) return { ...process.env };
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => GATEWAY_SAFE_ENV.has(k.toUpperCase())));
}

/** Names (never values) of the user's own HKCU variables the gateway does not pass on. */
function userOnlyVarName() {
  const r = spawnSync('reg', ['query', 'HKCU\\Environment'], { encoding: 'utf8', windowsHide: true });
  const names = [...String(r.stdout || '').matchAll(/^\s{4}(\S+)\s+REG_/gm)].map((m) => m[1]);
  const pick = names.find((n) => n.toUpperCase() === 'GOPATH') ||
    names.find((n) => !GATEWAY_SAFE_ENV.has(n.toUpperCase()) && !['PATH', 'TEMP', 'TMP'].includes(n.toUpperCase()));
  return pick || null;
}
const serverDirArg = argv.includes('--server-dir') ? argv[argv.indexOf('--server-dir') + 1] : null;
// --app-root runs the launcher and UI from a staged copy (scripts/stage.mjs) and
// lets it find the server build through its own dev-config.json.
const APP = argv.includes('--app-root') ? path.resolve(argv[argv.indexOf('--app-root') + 1]) : null;
const APP_ROOT = APP || ROOT;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A git worktree has no .cache of its own: its gitignored dev-config.json names
// the main checkout's server build (`serverDir`) and playwright install
// (`smokeDepsRoot`), so a worktree never downloads a second copy.
function readDevConfig() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(ROOT, 'dev-config.json'), 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
const DEV = readDevConfig();

function findCachedServer() {
  const root = path.join(ROOT, '.cache', 'serve-web', 'cli-data', 'serve-web');
  if (!fs.existsSync(root)) {
    return DEV.serverDir && fs.existsSync(path.join(DEV.serverDir, 'out', 'server-main.js')) ? DEV.serverDir : null;
  }
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (fs.existsSync(path.join(dir, 'out', 'server-main.js'))) return dir;
  }
  return null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function rawRequest({ port, method = 'GET', path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

let SECRET;
let PORT;
async function api(method, p, json) {
  const body = json === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(json));
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = { 'x-kirocrew-proxy': signProxyRequest({ secret: SECRET, ts, method, target: p, body }) };
  if (body.length) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = body.length;
  }
  const r = await rawRequest({ port: PORT, method, path: p, headers, body: body.length ? body : undefined });
  let parsed = null;
  try {
    parsed = JSON.parse(r.body);
  } catch {
    /* not json */
  }
  return { ...r, json: parsed };
}

function wsUpgrade(port, p, { origin = `http://127.0.0.1:${port}`, host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(
        [
          `GET ${p} HTTP/1.1`,
          `Host: ${host}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          ...(origin ? [`Origin: ${origin}`] : []),
          '',
          '',
        ].join('\r\n'),
      );
    });
    let buf = '';
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n')) done(buf.split('\r\n')[0]);
    });
    sock.on('error', (e) => done(`error ${e.message}`));
    setTimeout(() => done(buf.split('\r\n')[0] || 'timeout'), 10000);
  });
}

function processTable() {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate | ConvertTo-Json -Compress'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  const rows = JSON.parse(r.stdout || '[]');
  return rows.map((x) => ({ pid: x.ProcessId, ppid: x.ParentProcessId, name: x.Name, created: String(x.CreationDate) }));
}

function descendants(table, rootPid) {
  const out = [];
  const root = table.find((p) => p.pid === rootPid);
  if (root) out.push(root);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    for (const p of table) {
      if (p.ppid === pid && !out.includes(p)) {
        out.push(p);
        queue.push(p.pid);
      }
    }
  }
  return out;
}

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => resolve(false));
    s.setTimeout(2000, () => {
      s.destroy();
      resolve(false);
    });
  });
}

// Round-2 UI checks, run in the stand-in dashboard once VS Code is up:
// the inset rounded card, theme sync, the frame surviving an unmount, and the
// composer's VS Code chip opening the chat's project folder.
async function uiRound2Checks({ page, frame, hostServer, target, chatProject, shotDir, getLoads }) {
  const HEX = /^#[0-9a-f]{6}$/;
  const frameHost = 'div[data-vscode-pane-frame-host]';

  // Item 1: the card matches the Sessions panel card and the frame is clipped to it.
  const card = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="vscode-pane-card"]');
    const host = document.querySelector('div[data-vscode-pane-frame-host]');
    const main = document.getElementById('main-content');
    if (!el || !host) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const mr = main.getBoundingClientRect();
    return {
      radius: cs.borderTopLeftRadius, border: cs.borderTopWidth, bg: cs.backgroundColor,
      inset: [r.left - mr.left, r.top - mr.top, mr.right - r.right, mr.bottom - r.bottom].map((n) => Math.round(n)),
      clip: host.style.clipPath, hostInside: hr.left >= r.left && hr.right <= r.right + 0.5 && hr.bottom <= r.bottom + 0.5 && hr.top >= r.top,
      bar: document.querySelector('[role="toolbar"]').getBoundingClientRect().height,
    };
  });
  check('pane is an inset card with the Sessions panel radius and border (16px, 1px, 8px inset)',
    card && card.radius === '16px' && card.border === '1px' && card.inset.every((n) => n === 8), JSON.stringify(card));
  check('frame sits inside the card and is clipped to its rounded bottom corners',
    card && card.hostInside && /round 0px 0px 15px 15px/.test(card.clip), card && card.clip);
  check('toolbar is one slim row inside the card', card && card.bar <= 36, card && `${card.bar}px`);

  // Item 2 (UI half): the palette is POSTed on mount and on every theme change.
  const waitTheme = async (pred, since = 0, ms = 10_000) => {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const hit = hostServer.themePosts.slice(since).reverse().find((p) => p.body && pred(p.body));
      if (hit) return hit.body;
      await sleep(200);
    }
    return null;
  };
  const dark = await waitTheme((b) => b.kind === 'dark' && b.vars && b.vars['--bg'] === '#21222c');
  check('theme POST on mount: kind dark with the dashboard palette', !!dark, dark ? `${Object.keys(dark.vars).length} vars` : JSON.stringify(hostServer.themePosts.slice(-1)));
  check('every theme value is normalised to #rrggbb (translucent and color-mix values composited)',
    dark && Object.values(dark.vars).every((v) => HEX.test(v)) && HEX.test(dark.vars['--search-highlight'] || '') && dark.vars['--accent'] === '#bd93f9',
    dark && JSON.stringify({ accent: dark.vars['--accent'], diffAdd: dark.vars['--diff-add'], search: dark.vars['--search-highlight'] }));
  const before = hostServer.themePosts.length;
  await page.evaluate(() => window.__standin.setTheme('light'));
  const light = await waitTheme((b) => b.kind === 'light' && b.vars['--bg'] === '#fafafa', before);
  check('theme change re-POSTs: kind light with the light palette', !!light && hostServer.themePosts.length > before, light && light.vars['--accent']);
  const cardBg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="vscode-pane-card"]')).backgroundColor);
  check('card and toolbar follow the dashboard variables', cardBg === 'rgb(255, 255, 255)', cardBg);
  const beforeDark = hostServer.themePosts.length;
  await page.evaluate(() => window.__standin.setTheme('dracula-dark'));
  check('switching back to the dark theme re-POSTs it', !!(await waitTheme((b) => b.kind === 'dark' && b.vars['--bg'] === '#21222c', beforeDark)));

  // Item 5: leaving the page and coming back keeps the same workbench.
  const stateBefore = (await api('GET', '/api/state')).json;
  const helloBefore = stateBefore && stateBefore.extension && stateBefore.extension.at;
  const activeBefore = stateBefore && stateBefore.activeEditor && stateBefore.activeEditor.path;
  await page.evaluate(() => document.querySelector('iframe[title="VS Code"]').setAttribute('data-smoke-mark', 'kept'));
  const loadsBefore = getLoads();
  const holderLoadsBefore = await page.evaluate(() => window.__vscodePane.loads);
  const counts0 = await page.evaluate(() => ({ m: window.__standin.mounts, u: window.__standin.unmounts }));
  await page.click('#nav-chat');
  await page.locator('[data-testid="composer-context-shelf"]').waitFor({ timeout: 5000 });
  const away = await page.evaluate(() => {
    const host = document.querySelector('div[data-vscode-pane-frame-host]');
    const f = document.querySelector('iframe[title="VS Code"]');
    return { unmounts: window.__standin.unmounts, pageGone: !document.querySelector('[data-testid="vscode-pane-card"]'),
      connected: !!(f && f.isConnected), visibility: host && getComputedStyle(host).visibility, visible: host && host.dataset.visible };
  });
  check('navigating away unmounts the page (as the dashboard router does)', away.pageGone && away.unmounts > counts0.u, JSON.stringify(away));
  check('while away the VS Code frame is hidden but still in the document', away.connected && away.visibility === 'hidden' && away.visible === 'false', JSON.stringify(away));
  await sleep(3000);
  await page.click('#nav-vscode');
  await page.locator('[data-testid="vscode-pane-card"]').waitFor({ timeout: 5000 });
  await sleep(1500);
  const back = await page.evaluate(() => {
    const host = document.querySelector('div[data-vscode-pane-frame-host]');
    const f = document.querySelector('iframe[title="VS Code"]');
    return { mounts: window.__standin.mounts, mark: f && f.getAttribute('data-smoke-mark'), loads: window.__vscodePane.loads,
      frames: document.querySelectorAll('iframe[title="VS Code"]').length, visible: host && host.dataset.visible };
  });
  check('coming back remounts the page and shows the same iframe element', back.mounts > counts0.m && back.mark === 'kept' && back.frames === 1 && back.visible === 'true', JSON.stringify(back));
  check('no new workbench load after the remount', getLoads() === loadsBefore && back.loads === holderLoadsBefore, `document loads ${loadsBefore} -> ${getLoads()}, frame loads ${holderLoadsBefore} -> ${back.loads}`);
  const stateAfter = (await api('GET', '/api/state')).json;
  check('the extension host did not restart (no new bridge hello)', stateAfter && stateAfter.extension && stateAfter.extension.at === helloBefore, `${helloBefore} -> ${stateAfter && stateAfter.extension && stateAfter.extension.at}`);
  const tab = ((await frame.locator('.tabs-container .tab.active').first().textContent({ timeout: 5000 }).catch(() => '')) || '').trim();
  check('the same editor is still open in the workbench', activeBefore && path.basename(activeBefore).toLowerCase() === path.basename(target).toLowerCase() && /hello\.txt/i.test(tab),
    `active ${activeBefore && path.basename(activeBefore)}, tab "${tab}"`);

  // Item 4: the composer chip opens VS Code on the chat's project folder.
  await page.click('#nav-chat');
  await page.locator('[data-session-control-chip]').click({ timeout: 5000 });
  let landed = '';
  const t = Date.now();
  while (Date.now() - t < 10_000) {
    landed = await page.evaluate(() => location.pathname + location.search);
    if (landed.startsWith('/apps/vscode-pane?folder=')) break;
    await sleep(200);
  }
  check('composer VS Code chip navigates to the app page with ?folder=<chat project>', landed === `/apps/vscode-pane?folder=${encodeURIComponent(chatProject)}`, landed);
  let src = '';
  let folderValue = '';
  const t2 = Date.now();
  while (Date.now() - t2 < 20_000) {
    src = (await page.locator('iframe[title="VS Code"]').getAttribute('src').catch(() => '')) || '';
    folderValue = await page.locator('#vscp-folder').inputValue().catch(() => '');
    if (src.includes(`folder=`) && decodeURIComponent(src.split('folder=')[1] || '').replace(/\//g, '\\').toLowerCase().endsWith(path.basename(chatProject).toLowerCase())) break;
    await sleep(300);
  }
  check('the page takes the folder param and the frame loads that folder', folderValue === chatProject && /chat-project$/i.test(decodeURIComponent(src.split('folder=')[1] || '')), `input ${folderValue}; src folder ${decodeURIComponent(src.split('folder=')[1] || '').slice(-40)}`);
  let explorer = '';
  const t3 = Date.now();
  while (Date.now() - t3 < 60_000) {
    explorer = ((await frame.locator('.explorer-folders-view, .monaco-workbench .pane-header').first().textContent({ timeout: 2000 }).catch(() => '')) || '');
    const title = await frame.locator('.monaco-workbench').count().catch(() => 0);
    const tree = ((await frame.locator('.explorer-folders-view').first().textContent({ timeout: 1000 }).catch(() => '')) || '');
    if (title && /from-chat\.md/i.test(tree)) {
      explorer = tree;
      break;
    }
    await sleep(1000);
  }
  check('VS Code shows the chat project in its explorer', /from-chat\.md/i.test(explorer), explorer.slice(0, 80));
  await sleep(1000);
  const shot = path.join(shotDir, 'pane-dark.png');
  await page.screenshot({ path: shot });
  check('dark-theme screenshot of the pane saved', fs.existsSync(shot), shot);
}

async function main() {
  if (process.platform !== 'win32') console.log('note: process-tree checks are written for Windows');
  const serverDir = serverDirArg || findCachedServer();
  if (APP) console.log(`app root ${APP} (server build from its dev-config.json)`);
  if (!serverDir && !APP) throw new Error('no VS Code server build; run the R1-B probe or pass --server-dir');
  const runDir = path.join(ROOT, '.cache', 'smoke', `run-${Date.now()}`);
  const dataDir = path.join(runDir, 'data');
  const workspace = path.join(runDir, 'workspace');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const target = path.join(workspace, 'hello.txt');
  fs.writeFileSync(target, ['line one', 'line two', 'line three is the target', 'line four', ''].join('\n'));
  fs.writeFileSync(path.join(workspace, 'other.js'), 'console.log("other");\n');
  // The chat's project folder in the stand-in, opened by the composer's VS Code chip.
  const chatProject = path.join(runDir, 'chat-project');
  fs.mkdirSync(chatProject, { recursive: true });
  fs.writeFileSync(path.join(chatProject, 'from-chat.md'), '# opened from the chat composer\n');

  SECRET = crypto.randomBytes(24).toString('hex');
  PORT = await freePort();
  console.log(`run dir ${runDir}\nserver build ${serverDir}\nlauncher port ${PORT}${MINIMAL_ENV ? '\nlauncher env: gateway minimal_env allowlist only' : ''}`);

  const launcher = spawn(process.execPath, [path.join(APP_ROOT, 'backend', 'launcher.mjs')], {
    cwd: APP_ROOT,
    env: {
      ...launcherBaseEnv(),
      PORT: String(PORT),
      // What the gateway sets on every backend; terminals must not inherit them.
      KIROCREW_SPAWNED: '1',
      KIROCREW_SPAWN_INSTANCE: `smoke${crypto.randomBytes(4).toString('hex')}`,
      KIROCREW_PROXY_SECRET: SECRET,
      KIROCREW_APP_NAME: 'vscode-pane',
      VSCODE_PANE_DATA_DIR: dataDir,
      VSCODE_PANE_WORKSPACE: workspace,
      ...(APP ? {} : { VSCODE_PANE_SERVER_DIR: serverDir }),
      VSCODE_PANE_NO_DOWNLOAD: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  launcher.stdout.on('data', (d) => process.stdout.write(`[launcher] ${d}`));
  launcher.stderr.on('data', (d) => process.stdout.write(`[launcher:err] ${d}`));

  let browser;
  let hostServer;
  let tree = [];
  let serverPort = 0;
  try {
    // 1. health
    let health;
    for (let i = 0; i < 100; i++) {
      health = await rawRequest({ port: PORT, path: '/health' }).catch(() => null);
      if (health && health.status === 200) break;
      await sleep(200);
    }
    check('/health answers 200 unsigned', health && health.status === 200, health && health.body);

    // 2. auth checks
    const unsigned = await rawRequest({ port: PORT, path: '/api/session' });
    check('/api/session refuses an unsigned request', unsigned.status === 401, String(unsigned.status));
    const badSig = await rawRequest({ port: PORT, path: '/api/session', headers: { 'x-kirocrew-proxy': `${Math.floor(Date.now() / 1000)}:${'0'.repeat(64)}` } });
    check('/api/session refuses a bad signature', badSig.status === 401, String(badSig.status));
    const bridgeNoSecret = await rawRequest({ port: PORT, path: '/api/bridge/commands?wait=0' });
    check('bridge endpoint refuses a request without the bridge secret', bridgeNoSecret.status === 401, String(bridgeNoSecret.status));

    // 3. session ready
    let session;
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      session = (await api('GET', '/api/session')).json;
      if (session && (session.ready || session.status === 'error')) break;
      await sleep(500);
    }
    check('/api/session reports ready', session && session.ready, session && `${session.status} ${session.message} ${session.error || ''} in ${Date.now() - t0} ms`);
    if (!session || !session.ready) throw new Error('server never became ready');
    const wbUrl = new URL(session.url);
    console.log(`workbench ${wbUrl.origin}${wbUrl.pathname.replace(/vsc-[^/]+/, 'vsc-<key>')}${wbUrl.search}`);
    const logText = fs.readFileSync(path.join(dataDir, 'logs', 'launcher.log'), 'utf8');
    serverPort = Number((/server spawned pid \d+ port (\d+)/.exec(logText) || [])[1] || 0);
    check('session URL uses 127.0.0.1 and the launcher port', wbUrl.hostname === '127.0.0.1' && Number(wbUrl.port) === PORT);
    check('session URL carries no connection token', !wbUrl.search.includes('tkn='));

    // 4. workbench HTML
    const wb = await rawRequest({ port: PORT, path: wbUrl.pathname + wbUrl.search, headers: { cookie: 'mc_token_5476=dashboard-secret' } });
    const csp = String(wb.headers['content-security-policy'] || '');
    check('workbench GET returns 200', wb.status === 200, `${wb.status}, ${wb.body.length} bytes`);
    check('workbench has no X-Frame-Options', !wb.headers['x-frame-options']);
    check('workbench CSP has no frame-ancestors', !/frame-ancestors/i.test(csp));
    check('workbench does not hand the token cookie to the browser', !String(wb.headers['set-cookie'] || '').includes('vscode-tkn'));
    const wrong = await rawRequest({ port: PORT, path: '/vsc-wrongkey/' });
    check('wrong frame prefix is 404', wrong.status === 404, String(wrong.status));
    if (serverPort) {
      const direct = await rawRequest({ port: serverPort, path: '/' });
      check('VS Code server itself refuses a request without the token', direct.status === 403, `server port ${serverPort} -> ${direct.status}`);
    }

    // 5. websocket
    const wsLine = await wsUpgrade(PORT, `${wbUrl.pathname}?reconnectionToken=${crypto.randomUUID()}&reconnection=false&skipWebSocketFrames=false`);
    check('WebSocket upgrade through the launcher returns 101', /^HTTP\/1\.1 101/.test(wsLine), wsLine);
    const wsPath = `${wbUrl.pathname}?reconnectionToken=${crypto.randomUUID()}&reconnection=false&skipWebSocketFrames=false`;
    const foreign = await wsUpgrade(PORT, wsPath, { origin: 'https://evil.example' });
    check('WebSocket upgrade from a foreign Origin is refused', /^HTTP\/1\.1 403/.test(foreign), foreign);
    const dash = await wsUpgrade(PORT, wsPath, { origin: 'http://localhost:5476' });
    check('WebSocket upgrade from the dashboard origin itself is refused (only the frame may connect)', /^HTTP\/1\.1 403/.test(dash), dash);
    const rebound = await rawRequest({ port: PORT, path: wbUrl.pathname, headers: { host: 'rebound.example' } });
    check('workbench request with a non-loopback Host is refused', rebound.status === 403, String(rebound.status));

    // 6. headless browser loads the app's real UI page in a dashboard stand-in on
    //    http://localhost:<port>; the page frames the workbench on 127.0.0.1 (cross-site).
    const exe = findBrowser();
    if (!check('found a local Chrome/Edge', !!exe, exe || '')) throw new Error('no browser');
    const pw = await loadPlaywright(DEV.smokeDepsRoot || ROOT);
    const hostPort = await freePort();
    hostServer = createDashboardStandin({ repoRoot: APP_ROOT, launcherPort: PORT, secret: SECRET, recentDirs: [workspace], chatCwd: chatProject });
    await new Promise((ok) => hostServer.listen(hostPort, '127.0.0.1', ok));
    browser = await pw.chromium.launch({ executablePath: exe, headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const frameErrors = [];
    const pageErrors = [];
    // Every workbench page load (the frame's own document), to prove a remount does not reload it.
    let workbenchLoads = 0;
    page.on('request', (r) => {
      if (r.resourceType() === 'document' && r.url().startsWith(`http://127.0.0.1:${PORT}/vsc-`)) workbenchLoads++;
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    page.on('response', (r) => {
      if (r.url().startsWith(`http://127.0.0.1:${PORT}/`) && r.status() >= 400) frameErrors.push(`${r.status()} ${r.url().replace(/vsc-[^/]+/, 'vsc-<key>').slice(0, 120)}`);
    });
    await page.goto(`http://localhost:${hostPort}/`);
    let uiUp = false;
    try {
      await page.locator('iframe[title="VS Code"]').waitFor({ timeout: 30_000 });
      uiUp = true;
    } catch {
      /* reported below */
    }
    check('UI page mounts and renders the VS Code iframe', uiUp, pageErrors.slice(0, 2).join('; '));
    const frameSrc = uiUp ? await page.locator('iframe[title="VS Code"]').getAttribute('src') : '';
    check('UI iframe points at 127.0.0.1 with the folder param', /^http:\/\/127\.0\.0\.1:\d+\/vsc-[^/]+\/\?folder=/.test(frameSrc || ''));
    const frame = page.frameLocator('iframe[title="VS Code"]');
    let workbenchUp = false;
    try {
      await frame.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
      workbenchUp = true;
    } catch {
      /* reported below */
    }
    check('workbench renders inside a cross-site iframe (localhost page -> 127.0.0.1 frame)', workbenchUp, frameErrors.slice(0, 3).join('; '));

    // 6b. a real VS Code terminal sees the user's environment, not the gateway's
    if (process.platform === 'win32' && workbenchUp) {
      const userVar = userOnlyVarName();
      const names = ['PSModulePath', 'USERNAME', 'ProgramFiles(x86)', ...(userVar ? [userVar] : []), 'KIROCREW_SPAWNED', 'KIROCREW_SPAWN_INSTANCE', 'KIROCREW_VSCODE_BRIDGE_SECRET', 'KIROCREW_PROXY_SECRET'];
      const outFile = path.join(runDir, 'terminal-env.txt');
      // Writes only set/unset/unexpanded per name, never a value.
      const probe = path.join(runDir, 'terminal-probe.ps1');
      fs.writeFileSync(
        probe,
        `${names.map((n) => `'${n}'`).join(',')} | ForEach-Object { $v = [Environment]::GetEnvironmentVariable($_); $s = if (-not $v) { 'unset' } elseif ($v -like '*%*') { 'unexpanded' } else { 'set' }; "$_=$s" } | Set-Content -Path '${outFile}'\r\n`,
      );
      const cmd = `& '${probe}'`;
      let termResult = null;
      try {
        await frame.locator('.monaco-workbench').click({ position: { x: 700, y: 400 } });
        await page.keyboard.press('Control+Backquote');
        // The terminal renders to a canvas, so there is no prompt text to wait for:
        // wait for its input element, give the shell time to start, and retry.
        await frame.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached', timeout: 30_000 });
        await sleep(6000);
        for (let attempt = 0; attempt < 3 && !fs.existsSync(outFile); attempt++) {
          await frame.locator('.xterm-helper-textarea').first().focus();
          await page.keyboard.type(cmd, { delay: 5 });
          await page.keyboard.press('Enter');
          for (let i = 0; i < 20 && !fs.existsSync(outFile); i++) await sleep(500);
        }
        await page.screenshot({ path: path.join(ROOT, '.cache', 'smoke', 'terminal.png') }).catch(() => {});
        await sleep(300);
        termResult = Object.fromEntries(fs.readFileSync(outFile, 'utf8').trim().split(/\r?\n/).map((l) => l.split('=')));
      } catch (e) {
        termResult = { error: e.message };
      }
      const show = JSON.stringify(termResult);
      check('VS Code terminal sees PSModulePath, USERNAME and ProgramFiles(x86)', termResult && termResult.PSModulePath === 'set' && termResult.USERNAME === 'set' && termResult['ProgramFiles(x86)'] === 'set', show);
      check(`VS Code terminal sees the user's own variable${userVar ? ` (${userVar})` : ''}, expanded`, userVar && termResult && termResult[userVar] === 'set', show);
      check('VS Code terminal does not inherit gateway tracking vars, the bridge secret or the proxy secret', termResult && ['KIROCREW_SPAWNED', 'KIROCREW_SPAWN_INSTANCE', 'KIROCREW_VSCODE_BRIDGE_SECRET', 'KIROCREW_PROXY_SECRET'].every((n) => termResult[n] === 'unset'), show);
    }

    // 7. bridge connects (the workbench starts the remote extension host)
    let st;
    const t1 = Date.now();
    while (Date.now() - t1 < 90_000) {
      st = (await api('GET', '/api/state')).json;
      if (st && st.connected && st.extension) break;
      await sleep(1000);
    }
    check('bridge extension connected and said hello', st && st.connected && st.extension, st && JSON.stringify(st.extension));
    check('server process keeps the gateway tracking var (seen from the extension host)', st && st.extension && st.extension.spawnTracked === true, st && st.extension && String(st.extension.spawnTracked));

    // 8. Kiro Crew -> VS Code: open a file at a line
    const open = await api('POST', '/api/open', { path: target, line: 3, column: 6 });
    check('POST /api/open is confirmed by the extension', open.status === 200 && open.json && open.json.ok, JSON.stringify(open.json));

    // 9. VS Code -> Kiro Crew: state reports the opened file
    let active = null;
    const t2 = Date.now();
    while (Date.now() - t2 < 15_000) {
      st = (await api('GET', '/api/state')).json;
      active = st && st.activeEditor;
      if (active && active.path && active.path.toLowerCase() === target.toLowerCase() && active.selection && active.selection.startLine === 3) break;
      await sleep(500);
    }
    check('/api/state reports the opened file as active at line 3', active && active.path.toLowerCase() === target.toLowerCase() && active.selection && active.selection.startLine === 3, active && `${active.path}:${active.selection && active.selection.startLine}`);

    // 10. file-menu contribution endpoint
    const fm = await api('POST', '/api/file-menu', { item_id: 'open-in-vscode', surface: 'file-overflow', path: path.join(workspace, 'other.js'), kind: 'file' });
    check('POST /api/file-menu answers with a toast message', fm.status === 200 && fm.json && typeof fm.json.message === 'string', fm.json && fm.json.message);
    let otherActive = false;
    const t3 = Date.now();
    while (Date.now() - t3 < 15_000) {
      st = (await api('GET', '/api/state')).json;
      if (st && st.activeEditor && /other\.js$/i.test(st.activeEditor.path)) {
        otherActive = true;
        break;
      }
      await sleep(500);
    }
    check('file-menu request opened other.js in VS Code', otherActive);

    // 11. the same round trip driven from the UI toolbar
    await page.fill('#vscp-open', target);
    await page.fill('input[aria-label="Line"]', '2');
    await page.click('form:has(#vscp-open) button[type="submit"]');
    let uiOpened = false;
    try {
      await page.getByText('Opened in VS Code').waitFor({ timeout: 15_000 });
      uiOpened = true;
    } catch {
      /* reported below */
    }
    check('toolbar "Open file" opens the file and shows the confirmation', uiOpened);
    let readout = '';
    const t4 = Date.now();
    while (Date.now() - t4 < 10_000) {
      readout = (await page.locator('text=/^Active: /').first().textContent().catch(() => '')) || '';
      if (/hello\.txt:2:/i.test(readout)) break;
      await sleep(500);
    }
    check('toolbar readout shows the active VS Code file and line', /hello\.txt:2:/i.test(readout), readout);

    // 12. screenshot
    await sleep(1500);
    const shotDir = path.join(ROOT, '.cache', 'smoke');
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = path.join(shotDir, 'workbench.png');
    await page.screenshot({ path: shot });
    check('screenshot saved', fs.existsSync(shot), shot);

    await uiRound2Checks({ page, frame, hostServer, target, chatProject, shotDir, getLoads: () => workbenchLoads });

    // 13. the launcher restarts a VS Code server that dies
    if (process.platform === 'win32') {
      const spawned = [...fs.readFileSync(path.join(dataDir, 'logs', 'launcher.log'), 'utf8').matchAll(/server spawned pid (\d+) port (\d+)/g)];
      const serverPid = Number(spawned.at(-1)[1]);
      spawnSync('taskkill', ['/PID', String(serverPid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      let back = null;
      const t5 = Date.now();
      await sleep(500);
      while (Date.now() - t5 < 30_000) {
        const s = (await api('GET', '/api/session')).json;
        const logNow = fs.readFileSync(path.join(dataDir, 'logs', 'launcher.log'), 'utf8');
        const respawns = [...logNow.matchAll(/server spawned pid (\d+) port (\d+)/g)];
        if (s && s.ready && respawns.length > spawned.length) {
          back = respawns.at(-1);
          break;
        }
        await sleep(500);
      }
      check('killed VS Code server is restarted and ready again', !!back, back ? `new pid ${back[1]} port ${back[2]} after ${Date.now() - t5} ms` : '');
      if (back) serverPort = Number(back[2]);
      const after = (await api('GET', '/api/session')).json;
      check('frame URL is unchanged across the restart', after && after.url === session.url);
      check('server generation advanced', after && after.generation > (session.generation || 0), `${session.generation} -> ${after && after.generation}`);
      // No page action: the UI notices the new generation, remounts the frame,
      // and the new extension host's bridge says hello again.
      let rehello = null;
      const t6 = Date.now();
      while (Date.now() - t6 < 60_000) {
        const st2 = (await api('GET', '/api/state')).json;
        if (st2 && st2.extension && Date.parse(st2.extension.at) > t5) {
          rehello = st2.extension.at;
          break;
        }
        await sleep(500);
      }
      check('bridge reconnects after the restart with no user action', !!rehello, rehello ? `${Date.now() - t5} ms after the kill` : '');
      const reopen = await api('POST', '/api/open', { path: target, line: 4 });
      check('POST /api/open works again after the restart', reopen.json && reopen.json.ok, JSON.stringify(reopen.json));
    }
  } catch (e) {
    check('smoke run completed without exception', false, e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (hostServer) hostServer.close();

    // 12. stop like the gateway does on Windows: tree kill by PID
    if (process.platform === 'win32') {
      tree = descendants(processTable(), launcher.pid);
      console.log(`process tree before stop: ${tree.map((p) => `${p.name}:${p.pid}`).join(', ')}`);
      spawnSync('taskkill', ['/PID', String(launcher.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      launcher.kill('SIGTERM');
    }
    await sleep(1500);
    if (process.platform === 'win32') {
      const after = processTable();
      const left = tree.filter((p) => after.some((a) => a.pid === p.pid && a.created === p.created));
      check('no process from this run remains', tree.length > 0 && left.length === 0, left.map((p) => `${p.name}:${p.pid}`).join(', ') || `${tree.length} processes stopped`);
    }
    check('launcher port is free', !(await portOpen(PORT)), String(PORT));
    if (serverPort) check('VS Code server port is free', !(await portOpen(serverPort)), String(serverPort));
    if (!KEEP) fs.rmSync(runDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\nsmoke: ${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
