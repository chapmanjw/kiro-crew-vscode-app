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
import { createGatewayMock } from '../test/support/gateway-mock.mjs';
import { toVsCodeTheme } from '../backend/lib/theme.mjs';
import { slotNameFor } from '../backend/lib/gateway.mjs';

// Two Kiro Crew palettes: one saved before the first start (seeded into the
// server's settings), one posted live through POST /api/theme.
const SEEDED_THEME = {
  kind: 'dark',
  vars: { '--bg': '#282a36', '--surface': '#343746', '--panel': '#21222c', '--border': '#44475a', '--text': '#f8f8f2', '--muted': '#a5a9c0', '--accent': '#bd93f9' },
};
const POSTED_THEME = {
  kind: 'light',
  vars: { '--bg': '#fbf7ef', '--surface': '#ffffff', '--panel': '#f2ecdf', '--border': '#d8cfbd', '--text': '#2b2620', '--muted': '#6f6658', '--accent': '#b4552d' },
};

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

// A worktree has no .cache of its own; its gitignored dev-config.json names the
// cached server build and where playwright-core is already installed.
function devConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'dev-config.json'), 'utf8')) || {};
  } catch {
    return {};
  }
}
const DEV = devConfig();
const DEPS_ROOT = DEV.smokeDepsRoot && fs.existsSync(DEV.smokeDepsRoot) ? DEV.smokeDepsRoot : ROOT;

function findCachedServer() {
  if (DEV.serverDir && fs.existsSync(path.join(DEV.serverDir, 'out', 'server-main.js'))) return DEV.serverDir;
  const root = path.join(ROOT, '.cache', 'serve-web', 'cli-data', 'serve-web');
  if (!fs.existsSync(root)) return null;
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

  SECRET = crypto.randomBytes(24).toString('hex');
  PORT = await freePort();
  console.log(`run dir ${runDir}\nserver build ${serverDir}\nlauncher port ${PORT}${MINIMAL_ENV ? '\nlauncher env: gateway minimal_env allowlist only' : ''}`);

  // A mock Kiro Crew gateway for the chat round trip; the launcher trades the
  // proxy secret for an app token there, as it would against the real one.
  const gatewayMock = createGatewayMock({ appName: 'vscode-pane', secret: SECRET });
  const gatewayOrigin = await gatewayMock.listen();

  // A theme saved by an earlier run: the launcher must seed it into the
  // server's settings before VS Code paints.
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'state', 'theme.json'), JSON.stringify({ ...SEEDED_THEME, updatedAt: new Date().toISOString() }));

  function startLauncher(port) {
    const child = spawn(process.execPath, [path.join(APP_ROOT, 'backend', 'launcher.mjs')], {
      cwd: APP_ROOT,
      env: {
        ...launcherBaseEnv(),
        PORT: String(port),
        // What the gateway sets on every backend; terminals must not inherit them.
        KIROCREW_SPAWNED: '1',
        KIROCREW_SPAWN_INSTANCE: `smoke${crypto.randomBytes(4).toString('hex')}`,
        KIROCREW_PROXY_SECRET: SECRET,
        KIROCREW_APP_NAME: 'vscode-pane',
        KIROCREW_GATEWAY_ORIGIN: gatewayOrigin,
        VSCODE_PANE_DATA_DIR: dataDir,
        VSCODE_PANE_WORKSPACE: workspace,
        ...(APP ? {} : { VSCODE_PANE_SERVER_DIR: serverDir }),
        VSCODE_PANE_NO_DOWNLOAD: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (d) => process.stdout.write(`[launcher] ${d}`));
    child.stderr.on('data', (d) => process.stdout.write(`[launcher:err] ${d}`));
    return child;
  }
  let launcher = startLauncher(PORT);
  const firstLauncherPort = PORT;

  let browser;
  let hostServer;
  let tree = [];
  let earlierTree = [];
  let serverPort = 0;
  let framePort = 0;
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
    framePort = Number(wbUrl.port);
    check('session URL uses 127.0.0.1 and the frame port, not the API port', wbUrl.hostname === '127.0.0.1' && framePort > 0 && framePort !== PORT, `frame ${framePort}, api ${PORT}`);
    check('session URL carries no connection token', !wbUrl.search.includes('tkn='));
    const savedFrame = JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'frame.json'), 'utf8'));
    check('frame port and path key are saved in the data dir', savedFrame.port === framePort && wbUrl.pathname.startsWith(`/vsc-${savedFrame.key}/`));
    const apiFrame = await rawRequest({ port: PORT, path: wbUrl.pathname });
    check('the API port does not serve the workbench', apiFrame.status === 404, String(apiFrame.status));

    // 3b. the theme saved before this start is seeded into the server's Machine settings
    const machine = JSON.parse(fs.readFileSync(path.join(dataDir, 'server-data', 'data', 'Machine', 'settings.json'), 'utf8'));
    const seeded = toVsCodeTheme(SEEDED_THEME);
    check(
      'saved Kiro Crew theme is seeded into Machine settings before first paint',
      machine['workbench.colorTheme'] === 'Dark Modern' && machine['workbench.colorCustomizations']?.['editor.background'] === seeded.colorCustomizations['editor.background'],
      `${machine['workbench.colorTheme']} ${machine['workbench.colorCustomizations']?.['editor.background']}`,
    );
    check('Copilot sign-in prompts are turned off by setting, not by removing extensions', machine['chat.titleBar.signIn.enabled'] === false && machine['chat.welcomePage.signIn.enabled'] === false && fs.existsSync(path.join(serverDir || DEV.serverDir || '', 'extensions', 'copilot', 'package.json')));
    const serverArgsLog = fs.readFileSync(path.join(dataDir, 'logs', 'launcher.log'), 'utf8');
    check('launcher log names the frame port', /frame 127\.0\.0\.1:\d+/.test(serverArgsLog));

    // 4. workbench HTML
    const wb = await rawRequest({ port: framePort, path: wbUrl.pathname + wbUrl.search, headers: { cookie: 'mc_token_5476=dashboard-secret' } });
    const csp = String(wb.headers['content-security-policy'] || '');
    check('workbench GET returns 200', wb.status === 200, `${wb.status}, ${wb.body.length} bytes`);
    check('workbench has no X-Frame-Options', !wb.headers['x-frame-options']);
    check('workbench CSP has no frame-ancestors', !/frame-ancestors/i.test(csp));
    check('workbench does not hand the token cookie to the browser', !String(wb.headers['set-cookie'] || '').includes('vscode-tkn'));
    const wrong = await rawRequest({ port: framePort, path: '/vsc-wrongkey/' });
    check('wrong frame prefix is 404', wrong.status === 404, String(wrong.status));
    if (serverPort) {
      const direct = await rawRequest({ port: serverPort, path: '/' });
      check('VS Code server itself refuses a request without the token', direct.status === 403, `server port ${serverPort} -> ${direct.status}`);
    }

    // 5. websocket
    const wsLine = await wsUpgrade(framePort, `${wbUrl.pathname}?reconnectionToken=${crypto.randomUUID()}&reconnection=false&skipWebSocketFrames=false`);
    check('WebSocket upgrade through the launcher returns 101', /^HTTP\/1\.1 101/.test(wsLine), wsLine);
    const wsPath = `${wbUrl.pathname}?reconnectionToken=${crypto.randomUUID()}&reconnection=false&skipWebSocketFrames=false`;
    const foreign = await wsUpgrade(framePort, wsPath, { origin: 'https://evil.example' });
    check('WebSocket upgrade from a foreign Origin is refused', /^HTTP\/1\.1 403/.test(foreign), foreign);
    const dash = await wsUpgrade(framePort, wsPath, { origin: 'http://localhost:5476' });
    check('WebSocket upgrade from the dashboard origin itself is refused (only the frame may connect)', /^HTTP\/1\.1 403/.test(dash), dash);
    const apiWs = await wsUpgrade(PORT, wsPath);
    check('the API port refuses WebSocket upgrades', !/^HTTP\/1\.1 101/.test(apiWs), apiWs || 'closed');
    const rebound = await rawRequest({ port: framePort, path: wbUrl.pathname, headers: { host: 'rebound.example' } });
    check('workbench request with a non-loopback Host is refused', rebound.status === 403, String(rebound.status));

    // 6. headless browser loads the app's real UI page in a dashboard stand-in on
    //    http://localhost:<port>; the page frames the workbench on 127.0.0.1 (cross-site).
    const exe = findBrowser();
    if (!check('found a local Chrome/Edge', !!exe, exe || '')) throw new Error('no browser');
    const pw = await loadPlaywright(DEPS_ROOT);
    const hostPort = await freePort();
    hostServer = createDashboardStandin({ repoRoot: APP_ROOT, launcherPort: PORT, secret: SECRET, recentDirs: [workspace] });
    await new Promise((ok) => hostServer.listen(hostPort, '127.0.0.1', ok));
    // A persistent profile, so browser-side VS Code state can be checked across
    // a launcher restart (step 15).
    const profileDir = path.join(runDir, 'browser-profile');
    browser = await pw.chromium.launchPersistentContext(profileDir, { executablePath: exe, headless: true, viewport: { width: 1400, height: 900 } });
    const page = browser.pages()[0] || (await browser.newPage());
    const frameErrors = [];
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    // Workbench console lines about chat participants and API proposals, shown when a chat check fails.
    const chatConsole = [];
    page.on('console', (m) => {
      const t = m.text();
      if (/participant|proposal|kiro-crew|defaultChat|No default agent/i.test(t)) chatConsole.push(t.slice(0, 300));
    });
    page.on('response', (r) => {
      if (r.url().startsWith(`http://127.0.0.1:${framePort}/`) && r.status() >= 400) frameErrors.push(`${r.status()} ${r.url().replace(/vsc-[^/]+/, 'vsc-<key>').slice(0, 120)}`);
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
        // Right after the workbench appears its keybindings may not be live yet,
        // so a single Ctrl+` can be lost: press it again until a terminal opens.
        let opened = false;
        for (let attempt = 0; attempt < 5 && !opened; attempt++) {
          await frame.locator('.monaco-workbench').click({ position: { x: 700, y: 400 } });
          await page.keyboard.press('Control+Backquote');
          // The terminal renders to a canvas, so there is no prompt text to wait for:
          // wait for its input element, give the shell time to start, and retry.
          opened = await frame.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached', timeout: 8_000 }).then(() => true, () => false);
        }
        if (!opened) throw new Error('the terminal did not open after 5 tries');
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

    // 7b. the built-in Chat is answered by Kiro Crew (the mock gateway)
    const cs0 = (await api('GET', '/api/chat/status?probe=1')).json;
    check(
      'GET /api/chat/status: gateway reachable with an exchanged app token',
      cs0 && cs0.available && cs0.gateway.reachable === true && cs0.gateway.token && gatewayMock.rec.exchanges >= 1,
      JSON.stringify(cs0 && { available: cs0.available, reason: cs0.reason, reachable: cs0.gateway.reachable, exchanges: gatewayMock.rec.exchanges }),
    );
    check(
      'bridge registered the default chat participant (proposed API enabled by the server flag)',
      cs0 && cs0.extension.chat && cs0.extension.chat.defaultParticipant === true && cs0.extension.chat.participant === true,
      JSON.stringify(cs0 && cs0.extension.chat),
    );
    const prompt = `smoke ${crypto.randomBytes(3).toString('hex')}: say hi`;
    const ask = await api('POST', '/api/chat/ask', { prompt });
    check('POST /api/chat/ask opens the VS Code Chat view with the prompt', ask.json && ask.json.ok, JSON.stringify(ask.json));
    let turn = null;
    const t7 = Date.now();
    while (Date.now() - t7 < 30_000) {
      turn = gatewayMock.rec.turns.find((t) => String(t.message).startsWith(prompt));
      if (turn) break;
      await sleep(300);
    }
    if (!check('the default Chat view sent the turn to Kiro Crew (no @mention, no Copilot)', !!turn, turn ? turn.message.slice(0, 160) : `turns seen: ${gatewayMock.rec.turns.length}`)) {
      console.log('workbench console (chat):\n  ' + chatConsole.slice(-20).join('\n  '));
    }
    const expectedSlot = slotNameFor(workspace);
    check(
      "the turn ran in the workspace folder's Kiro Crew chat slot",
      turn && turn.slot === expectedSlot && String(gatewayMock.rec.slots.get(expectedSlot)?.project).toLowerCase() === workspace.toLowerCase(),
      turn && `${turn.slot} project=${gatewayMock.rec.slots.get(turn.slot)?.project}`,
    );
    let chatShown = false;
    try {
      await frame.locator('text=Kiro Crew mock').first().waitFor({ timeout: 20_000 });
      chatShown = true;
    } catch {
      /* reported below */
    }
    check('the Kiro Crew reply streams into the VS Code Chat view', chatShown);
    let cs1 = null;
    const t7b = Date.now();
    while (Date.now() - t7b < 10_000) {
      cs1 = (await api('GET', '/api/chat/status')).json;
      if (cs1 && cs1.lastTurn) break;
      await sleep(300);
    }
    check('chat status records the finished turn', cs1 && cs1.lastTurn && cs1.lastTurn.outcome === 'done' && cs1.turns >= 1, JSON.stringify(cs1 && cs1.lastTurn));
    fs.mkdirSync(path.join(ROOT, '.cache', 'smoke'), { recursive: true });
    await page.screenshot({ path: path.join(ROOT, '.cache', 'smoke', 'chat.png') });

    // 7c. theme: the seeded palette is applied by the bridge, then a new one is posted live
    const seededVs = toVsCodeTheme(SEEDED_THEME);
    let th = null;
    const t8 = Date.now();
    while (Date.now() - t8 < 20_000) {
      th = (await api('GET', '/api/state')).json?.theme;
      if (th && th.applied && th.readBack) break;
      await sleep(300);
    }
    check(
      'bridge wrote the seeded theme to the user settings (read back through the bridge)',
      th && th.applied && th.readBack && th.readBack.colorTheme === 'Dark Modern' && th.readBack.editorBackground === seededVs.colorCustomizations['editor.background'],
      JSON.stringify(th && th.readBack),
    );
    const badTheme = await api('POST', '/api/theme', { kind: 'dark', vars: { '--bg': 'red', '--text': '#ffffff' } });
    check('POST /api/theme refuses a non-hex colour', badTheme.status === 400, `${badTheme.status} ${badTheme.json && badTheme.json.error}`);
    const unsignedTheme = await rawRequest({ port: PORT, method: 'POST', path: '/api/theme', headers: { 'content-type': 'application/json' }, body: JSON.stringify(POSTED_THEME) });
    check('POST /api/theme refuses an unsigned request', unsignedTheme.status === 401, String(unsignedTheme.status));
    const posted = await api('POST', '/api/theme', POSTED_THEME);
    check(
      'POST /api/theme stores a new palette',
      posted.status === 200 && posted.json.changed === true && posted.json.colorTheme === 'Light Modern',
      JSON.stringify(posted.json && { changed: posted.json.changed, colorTheme: posted.json.colorTheme }),
    );
    const wantVs = toVsCodeTheme(POSTED_THEME);
    let th2 = null;
    const t9 = Date.now();
    while (Date.now() - t9 < 20_000) {
      th2 = (await api('GET', '/api/state')).json?.theme;
      if (th2 && th2.readBack && th2.readBack.colorTheme === 'Light Modern') break;
      await sleep(300);
    }
    check(
      'the workbench setting read back through the bridge is the posted theme',
      th2 && th2.readBack && th2.readBack.colorTheme === wantVs.colorTheme && th2.readBack.editorBackground === wantVs.colorCustomizations['editor.background'] && th2.readBack.count === Object.keys(wantVs.colorCustomizations).length,
      JSON.stringify(th2 && th2.readBack),
    );
    const hexToRgb = (h) => `rgb(${[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ')})`;
    let painted = '';
    const t9b = Date.now();
    while (Date.now() - t9b < 10_000) {
      painted = await frame.locator('.monaco-workbench .part.statusbar').first().evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => '');
      if (painted === hexToRgb(wantVs.colorCustomizations['statusBar.background'])) break;
      await sleep(300);
    }
    check('the workbench repaints in the posted palette (status bar)', painted === hexToRgb(wantVs.colorCustomizations['statusBar.background']), `${painted} want ${hexToRgb(wantVs.colorCustomizations['statusBar.background'])}`);
    const machine2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'server-data', 'data', 'Machine', 'settings.json'), 'utf8'));
    check('the posted theme is also seeded for the next start', machine2['workbench.colorTheme'] === 'Light Modern');
    const again = await api('POST', '/api/theme', POSTED_THEME);
    check('posting the same palette again changes nothing', again.json && again.json.changed === false);

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

    // 14. reload the pane: VS Code restores its open editor from browser-side
    //     storage, and the theme is not written again
    {
      const before = (await api('GET', '/api/state')).json?.activeEditor?.path || '';
      const t10 = Date.now();
      await page.reload();
      await frame.locator('.monaco-workbench').waitFor({ timeout: 60_000 }).catch(() => {});
      let st3 = null;
      while (Date.now() - t10 < 60_000) {
        st3 = (await api('GET', '/api/state')).json;
        if (st3 && st3.extension && Date.parse(st3.extension.at) > t10 && st3.activeEditor && st3.activeEditor.path) break;
        await sleep(500);
      }
      check(
        'after a reload of the pane the open editor is restored without reopening it',
        before && st3 && st3.activeEditor && st3.activeEditor.path.toLowerCase() === before.toLowerCase(),
        `${before} -> ${st3 && st3.activeEditor && st3.activeEditor.path}`,
      );
      let th3 = null;
      while (Date.now() - t10 < 75_000) {
        th3 = (await api('GET', '/api/state')).json?.theme;
        if (th3 && Date.parse(th3.at) > t10) break;
        await sleep(500);
      }
      check('after a reload the theme is confirmed unchanged, not rewritten', th3 && Date.parse(th3.at) > t10 && th3.applied && th3.changed === false, JSON.stringify(th3 && { changed: th3.changed, at: th3.at }));
      const reopenAfterReload = await api('POST', '/api/open', { path: path.join(workspace, 'other.js') });
      check('commands reach the new window after a reload (not the lingering old host)', reopenAfterReload.json && reopenAfterReload.json.ok, JSON.stringify(reopenAfterReload.json));
      const back2 = await api('POST', '/api/open', { path: target, line: 2 });
      check('hello.txt reopened for the restart check', back2.json && back2.json.ok);
      await sleep(3000); // let the workbench flush its storage
    }

    // 15. restart the launcher (a gateway restart): same frame origin and path,
    //     and the workbench comes back with its editor
    if (process.platform === 'win32') {
      const urlBefore = new URL((await api('GET', '/api/session')).json.url);
      earlierTree = descendants(processTable(), launcher.pid);
      await browser.close();
      browser = null;
      hostServer.close();
      spawnSync('taskkill', ['/PID', String(launcher.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      await sleep(1500);
      PORT = await freePort();
      launcher = startLauncher(PORT);
      let s2 = null;
      const t11 = Date.now();
      while (Date.now() - t11 < 120_000) {
        s2 = (await api('GET', '/api/session').catch(() => ({ json: null }))).json;
        if (s2 && (s2.ready || s2.status === 'error')) break;
        await sleep(500);
      }
      const urlAfter = s2 && s2.url ? new URL(s2.url) : null;
      check(
        'after a launcher restart on a new API port, the frame keeps its origin and path',
        urlAfter && PORT !== firstLauncherPort && urlAfter.origin === urlBefore.origin && urlAfter.pathname === urlBefore.pathname,
        urlAfter ? `api ${firstLauncherPort} -> ${PORT}; frame ${urlBefore.port} -> ${urlAfter.port}` : 'not ready',
      );
      const logNow = fs.readFileSync(path.join(dataDir, 'logs', 'launcher.log'), 'utf8');
      const spawnedNow = [...logNow.matchAll(/server spawned pid (\d+) port (\d+)/g)];
      if (spawnedNow.length) serverPort = Number(spawnedNow.at(-1)[2]);
      const hostPort2 = await freePort();
      hostServer = createDashboardStandin({ repoRoot: APP_ROOT, launcherPort: PORT, secret: SECRET, recentDirs: [workspace] });
      await new Promise((ok) => hostServer.listen(hostPort2, '127.0.0.1', ok));
      const pw2 = await loadPlaywright(DEPS_ROOT);
      // Same browser profile as before: the browser keeps its storage, the
      // frame origin is the same, so VS Code finds its state again.
      browser = await pw2.chromium.launchPersistentContext(path.join(runDir, 'browser-profile'), { executablePath: findBrowser(), headless: true, viewport: { width: 1400, height: 900 } });
      const page2 = browser.pages()[0] || (await browser.newPage());
      await page2.goto(`http://localhost:${hostPort2}/`);
      const t12 = Date.now();
      let st4 = null;
      while (Date.now() - t12 < 90_000) {
        st4 = (await api('GET', '/api/state')).json;
        if (st4 && st4.extension && Date.parse(st4.extension.at) > t12 && st4.activeEditor && st4.activeEditor.path) break;
        await sleep(500);
      }
      check('after the launcher restart the pane loads and the bridge says hello', st4 && st4.extension && Date.parse(st4.extension.at) > t12);
      check(
        'after the launcher restart VS Code restores the open editor from browser storage',
        st4 && st4.activeEditor && st4.activeEditor.path.toLowerCase() === target.toLowerCase(),
        st4 && st4.activeEditor ? st4.activeEditor.path : 'no active editor',
      );
      let th4 = null;
      const t13 = Date.now();
      while (Date.now() - t13 < 20_000) {
        th4 = (await api('GET', '/api/state')).json?.theme;
        if (th4 && th4.readBack) break;
        await sleep(500);
      }
      check('after the launcher restart the stored theme is still in effect', th4 && th4.readBack && th4.readBack.colorTheme === 'Light Modern', JSON.stringify(th4 && th4.readBack));
      await page2.screenshot({ path: path.join(ROOT, '.cache', 'smoke', 'after-restart.png') });
      const cs2 = (await api('GET', '/api/chat/status?probe=1')).json;
      check('after the launcher restart chat is available again with a fresh app token', cs2 && cs2.available && cs2.gateway.reachable === true, JSON.stringify(cs2 && cs2.gateway && { reachable: cs2.gateway.reachable, lastError: cs2.gateway.lastError }));
    }
  } catch (e) {
    check('smoke run completed without exception', false, e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (hostServer) hostServer.close();
    await gatewayMock.close();

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
      const left = [...earlierTree, ...tree].filter((p) => after.some((a) => a.pid === p.pid && a.created === p.created));
      check('no process from this run remains', tree.length > 0 && left.length === 0, left.map((p) => `${p.name}:${p.pid}`).join(', ') || `${tree.length} processes stopped`);
    }
    check('launcher port is free', !(await portOpen(PORT)), String(PORT));
    if (serverPort) check('VS Code server port is free', !(await portOpen(serverPort)), String(serverPort));
    if (framePort) check('frame port is free', !(await portOpen(framePort)), String(framePort));
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
