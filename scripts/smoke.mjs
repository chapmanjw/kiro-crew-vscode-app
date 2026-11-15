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
const serverDirArg = argv.includes('--server-dir') ? argv[argv.indexOf('--server-dir') + 1] : null;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findCachedServer() {
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

function wsUpgrade(port, p) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(
        [
          `GET ${p} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          'Origin: http://127.0.0.1:' + port,
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
  if (!serverDir) throw new Error('no VS Code server build; run the R1-B probe or pass --server-dir');
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
  console.log(`run dir ${runDir}\nserver build ${serverDir}\nlauncher port ${PORT}`);

  const launcher = spawn(process.execPath, [path.join(ROOT, 'backend', 'launcher.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      KIROCREW_PROXY_SECRET: SECRET,
      KIROCREW_APP_NAME: 'vscode-pane',
      VSCODE_PANE_DATA_DIR: dataDir,
      VSCODE_PANE_WORKSPACE: workspace,
      VSCODE_PANE_SERVER_DIR: serverDir,
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

    // 6. headless browser loads the app's real UI page in a dashboard stand-in on
    //    http://localhost:<port>; the page frames the workbench on 127.0.0.1 (cross-site).
    const exe = findBrowser();
    if (!check('found a local Chrome/Edge', !!exe, exe || '')) throw new Error('no browser');
    const pw = await loadPlaywright(ROOT);
    const hostPort = await freePort();
    hostServer = createDashboardStandin({ repoRoot: ROOT, launcherPort: PORT, secret: SECRET, recentDirs: [workspace] });
    await new Promise((ok) => hostServer.listen(hostPort, '127.0.0.1', ok));
    browser = await pw.chromium.launch({ executablePath: exe, headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const frameErrors = [];
    const pageErrors = [];
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

    // 7. bridge connects (the workbench starts the remote extension host)
    let st;
    const t1 = Date.now();
    while (Date.now() - t1 < 90_000) {
      st = (await api('GET', '/api/state')).json;
      if (st && st.connected && st.extension) break;
      await sleep(1000);
    }
    check('bridge extension connected and said hello', st && st.connected && st.extension, st && JSON.stringify(st.extension));

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
