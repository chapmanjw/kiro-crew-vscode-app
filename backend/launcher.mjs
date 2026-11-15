#!/usr/bin/env node
// vscode-pane launcher: the Kiro Crew app backend.
//
// Binds 127.0.0.1:$PORT (assigned by the gateway) and serves
//   /health                 unsigned health check
//   /api/*                  JSON API, reached through the gateway proxy (HMAC-checked)
//   /api/bridge/*           long poll + events for the VS Code bridge extension (bridge secret)
//   /vsc-<key>/*            the VS Code workbench, reverse-proxied to the server (HTTP + WebSocket)
// and supervises the official VS Code server (`node out/server-main.js`) as a child.
// Node built-ins only, so the gateway's npm install step has nothing to do.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveDataDir, parseConfig, effectiveConfig } from './lib/config.mjs';
import { parseCodeVersion, findServerBuild, serverDownloadUrl, nodeExeName } from './lib/discovery.mjs';
import { buildServerArgs, buildServerEnv, workbenchUrl } from './lib/args.mjs';
import { verifyProxySignature, checkBridgeSecret, randomSecret, PROXY_HEADER, BRIDGE_HEADER } from './lib/auth.mjs';
import { matchRoute, parseOpenRequest, fileMenuToCommand } from './lib/router.mjs';
import { Bridge } from './lib/bridge.mjs';
import { BRIDGE_ID, bridgeFolderName, upsertBridgeEntry, staleBridgeFolders } from './lib/extensions.mjs';
import { createFrameProxy } from './lib/frameproxy.mjs';
import { provisionServer } from './lib/provision.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const PORT = Number(env.PORT || 0);
const HOST = '127.0.0.1';
const DATA_DIR = resolveDataDir(env, APP_ROOT);
const PROXY_SECRET = env.KIROCREW_PROXY_SECRET || '';
const ALLOW_UNSIGNED = env.VSCODE_PANE_ALLOW_UNSIGNED === '1';
const MAX_BODY = 64 * 1024;

fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'run'), { recursive: true });
const logStream = fs.createWriteStream(path.join(DATA_DIR, 'logs', 'launcher.log'), { flags: 'a' });
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  logStream.write(line + '\n');
  if (env.VSCODE_PANE_VERBOSE === '1') console.log(line);
}

let fileConfig = {};
try {
  fileConfig = parseConfig(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
} catch {
  /* no config file */
}
const config = effectiveConfig(fileConfig, env, { homedir: os.homedir(), appRoot: APP_ROOT });

const FRAME_KEY = randomSecret(18);
const BASE_PATH = `/vsc-${FRAME_KEY}`;
const BRIDGE_SECRET = randomSecret(24);
const bridge = new Bridge();

const state = {
  status: 'idle', // idle | provisioning | starting | ready | error | stopped
  message: '',
  error: null,
  build: null, // {dir, source, commit}
  serverPort: 0,
  token: null,
  child: null,
  startedAt: null,
  restarts: 0,
  stopping: false,
};

function setStatus(status, message = '', error = null) {
  state.status = status;
  state.message = message;
  state.error = error;
  log('status', status, message, error || '');
}

// ---------------------------------------------------------------------------
// VS Code server lifecycle

let codeVersion; // cached { version, commit }
function detectCodeVersion() {
  if (codeVersion !== undefined) return codeVersion;
  try {
    const cli = config.codeCli;
    const r = spawnSync(/\s/.test(cli) ? `"${cli}"` : cli, ['--version'], {
      shell: process.platform === 'win32',
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
      env: Object.fromEntries(Object.entries(env).filter(([k]) => !k.toUpperCase().startsWith('VSCODE_'))),
    });
    codeVersion = r.status === 0 ? parseCodeVersion(r.stdout) : { version: null, commit: null };
  } catch {
    codeVersion = { version: null, commit: null };
  }
  log('code --version', JSON.stringify(codeVersion));
  return codeVersion;
}

function listDirs(p) {
  return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

async function ensureBuild() {
  const commit = config.serverDir ? null : detectCodeVersion().commit;
  const found = findServerBuild({
    configured: config.serverDir,
    dataDir: DATA_DIR,
    devCacheRoot: config.devCacheRoot,
    commit,
    exists: fs.existsSync,
    listDirs,
  });
  // An exact match (or a build we cannot compare) is used as is.
  if (found && (found.source === 'configured' || !commit || found.commit === commit)) return found;
  if (commit && config.allowDownload) {
    try {
      setStatus('provisioning', 'Downloading VS Code server');
      const dir = await provisionServer({
        url: serverDownloadUrl(commit),
        dataDir: DATA_DIR,
        commit,
        onStatus: (m) => setStatus('provisioning', m),
      });
      return { dir, source: 'download', commit };
    } catch (e) {
      if (!found) throw e;
      log('download failed, using older build', e.message);
    }
  }
  if (found) return found;
  throw new Error(
    commit
      ? 'No VS Code server build found and downloads are disabled. Set serverDir in data/config.json.'
      : 'No VS Code server build found and the `code` CLI is not available to say which build to download. Set serverDir in data/config.json.',
  );
}

function installBridgeExtension() {
  const src = path.join(APP_ROOT, 'extension', 'kiro-crew-bridge');
  const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
  const extDir = path.join(DATA_DIR, 'extensions');
  fs.mkdirSync(extDir, { recursive: true });
  const folderName = bridgeFolderName(pkg.version);
  const dest = path.join(extDir, folderName);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  for (const stale of staleBridgeFolders(listDirs(extDir), folderName)) {
    fs.rmSync(path.join(extDir, stale), { recursive: true, force: true });
  }
  const listFile = path.join(extDir, 'extensions.json');
  if (fs.existsSync(listFile)) {
    let existing = [];
    try {
      existing = JSON.parse(fs.readFileSync(listFile, 'utf8'));
    } catch {
      existing = [];
    }
    const next = upsertBridgeEntry(existing, { version: pkg.version, folderPath: dest, folderName });
    fs.writeFileSync(listFile, JSON.stringify(next));
  }
  log('bridge extension installed', BRIDGE_ID, pkg.version);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, HOST, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function probe(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: p, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => req.destroy());
  });
}

async function waitReady(port, child, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) return false;
    // /version is served without a connection token and answers once the server listens.
    if ((await probe(port, '/version')) === 200) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
    }
  } catch {
    /* already gone */
  }
}

let restartTimer = null;
let launching = false;

async function launchServer() {
  if (launching || state.stopping) return;
  launching = true;
  try {
    if (!state.build) {
      setStatus('provisioning', 'Locating VS Code server');
      state.build = await ensureBuild();
      log('server build', state.build.source, state.build.dir);
    }
    setStatus('starting', 'Starting VS Code server');
    installBridgeExtension();
    const port = await freePort();
    const token = randomSecret(24);
    const tokenFile = path.join(DATA_DIR, 'run', 'connection-token');
    fs.writeFileSync(tokenFile, token, { mode: 0o600 });
    fs.mkdirSync(path.join(DATA_DIR, 'server-data'), { recursive: true });
    const args = buildServerArgs({
      port,
      tokenFile,
      dataDir: DATA_DIR,
      workspace: fs.existsSync(config.workspace) ? config.workspace : null,
      basePath: BASE_PATH,
    });
    const childEnv = buildServerEnv(env, { bridgeUrl: `http://${HOST}:${listenPort}`, bridgeSecret: BRIDGE_SECRET });
    const nodeExe = path.join(state.build.dir, nodeExeName());
    const serverLog = fs.createWriteStream(path.join(DATA_DIR, 'logs', 'vscode-server.log'), { flags: 'a' });
    const child = spawn(nodeExe, args, {
      cwd: state.build.dir,
      env: childEnv,
      windowsHide: true,
      detached: process.platform !== 'win32', // own process group on POSIX for a group kill
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(serverLog, { end: false });
    child.stderr.pipe(serverLog, { end: false });
    state.child = child;
    state.serverPort = port;
    state.token = token;
    log('server spawned pid', child.pid, 'port', port);
    child.on('exit', (code, signal) => {
      log('server exited', code, signal);
      serverLog.end();
      if (state.child === child) {
        state.child = null;
        state.serverPort = 0;
        state.token = null;
      }
      if (!state.stopping && !child.__replaced) scheduleRestart(`VS Code server exited (${code ?? signal})`);
    });
    child.on('error', (e) => log('server spawn error', e.message));
    const ok = await waitReady(port, child);
    if (!ok) {
      killTree(child.pid);
      throw new Error('VS Code server did not become ready; see data/logs/vscode-server.log');
    }
    state.startedAt = new Date().toISOString();
    state.restarts = 0;
    setStatus('ready', 'VS Code is running');
  } catch (e) {
    setStatus('error', 'VS Code server failed to start', e.message);
    if (!state.child) scheduleRestart(e.message, true);
  } finally {
    launching = false;
  }
}

function scheduleRestart(reason, keepError = false) {
  if (state.stopping || restartTimer) return;
  state.restarts += 1;
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(state.restarts - 1, 5));
  if (!keepError) setStatus('starting', `${reason}; restarting in ${Math.round(delay / 1000)} s`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    launchServer();
  }, delay);
  restartTimer.unref?.();
}

async function restartServer() {
  const old = state.child;
  if (old) {
    old.__replaced = true;
    killTree(old.pid);
  }
  state.child = null;
  state.serverPort = 0;
  state.token = null;
  clearTimeout(restartTimer);
  restartTimer = null;
  state.restarts = 0;
  await launchServer();
}

// ---------------------------------------------------------------------------
// HTTP

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function parseJson(buf) {
  if (!buf || !buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return undefined;
  }
}

function isLoopbackHost(hostHeader) {
  const h = String(hostHeader || '').replace(/:\d+$/, '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
}

function sessionBody(folderParam) {
  const folder = folderParam || (fs.existsSync(config.workspace) ? config.workspace : null);
  const ready = state.status === 'ready' && !!state.serverPort;
  return {
    status: state.status,
    ready,
    message: state.message,
    error: state.error,
    url: ready ? workbenchUrl({ host: HOST, port: listenPort, basePath: BASE_PATH, folder }) : null,
    folder,
    defaultFolder: config.workspace,
    server: state.build ? { source: state.build.source, commit: state.build.commit, startedAt: state.startedAt } : null,
    bridge: { connected: bridge.connected, extension: bridge.extension },
  };
}

const frameProxy = createFrameProxy(() =>
  state.status === 'ready' && state.serverPort ? { port: state.serverPort, token: state.token } : null,
);

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  const route = matchRoute(req.method, url.pathname, BASE_PATH);
  if (route.error) return sendJson(res, route.error, { error: route.error === 404 ? 'not found' : 'method not allowed' });

  if (route.auth === 'frame') return frameProxy.handleRequest(req, res);
  if (!isLoopbackHost(req.headers.host)) return sendJson(res, 403, { error: 'bad host' });

  let body;
  try {
    body = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
  } catch (e) {
    return sendJson(res, e.status || 400, { error: e.message });
  }

  if (route.auth === 'proxy') {
    if (PROXY_SECRET) {
      const ok = verifyProxySignature({
        secret: PROXY_SECRET,
        header: req.headers[PROXY_HEADER],
        method: req.method,
        target: req.url,
        body,
      });
      if (!ok) return sendJson(res, 401, { error: 'missing or invalid X-KiroCrew-Proxy signature' });
    } else if (!ALLOW_UNSIGNED) {
      return sendJson(res, 401, { error: 'no KIROCREW_PROXY_SECRET; set VSCODE_PANE_ALLOW_UNSIGNED=1 for standalone dev' });
    }
  } else if (route.auth === 'bridge') {
    if (!checkBridgeSecret(BRIDGE_SECRET, req.headers[BRIDGE_HEADER])) {
      return sendJson(res, 401, { error: 'bad bridge secret' });
    }
  }

  switch (route.name) {
    case 'health':
      return sendJson(res, 200, { ok: true, status: state.status });
    case 'session':
      return sendJson(res, 200, sessionBody(url.searchParams.get('folder')));
    case 'state':
      return sendJson(res, 200, { ...bridge.snapshot(), serverStatus: state.status });
    case 'open': {
      const parsed = parseOpenRequest(parseJson(body));
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      const { id, done } = bridge.enqueue(parsed.command, 8000);
      const result = await done;
      return sendJson(res, 200, { id, command: parsed.command, ...result, bridgeConnected: bridge.connected });
    }
    case 'restart':
      restartServer();
      return sendJson(res, 202, { ok: true, status: 'restarting' });
    case 'fileMenu': {
      const parsed = fileMenuToCommand(parseJson(body));
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      bridge.enqueue(parsed.command, 8000);
      const origin = env.KIROCREW_GATEWAY_ORIGIN;
      const name = path.basename(parsed.command.path);
      return sendJson(res, 200, {
        message: bridge.connected
          ? `Opening ${name} in VS Code`
          : `Queued ${name} for VS Code; open the VS Code app page to see it`,
        ...(origin ? { url: `${origin.replace(/\/$/, '')}/apps/vscode-pane` } : {}),
      });
    }
    case 'bridgeCommands': {
      const wait = Math.min(Math.max(Number(url.searchParams.get('wait')) || 25, 0), 25) * 1000;
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const batch = await bridge.take(wait, ac.signal);
      if (res.destroyed || res.writableEnded) {
        bridge.requeue(batch);
        return;
      }
      return sendJson(res, 200, { commands: batch });
    }
    case 'bridgeEvents': {
      const ev = parseJson(body);
      if (!bridge.applyEvent(ev)) return sendJson(res, 400, { error: 'unknown event' });
      res.writeHead(204);
      return res.end();
    }
    default:
      return sendJson(res, 404, { error: 'not found' });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('handler error', e.stack || e.message);
    sendJson(res, 500, { error: 'internal error' });
  });
});
server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  if (p === BASE_PATH || p.startsWith(BASE_PATH + '/')) return frameProxy.handleUpgrade(req, socket, head);
  socket.destroy();
});
// Long polls and VS Code's long-lived requests must not be cut by Node's defaults.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 5_000;

let listenPort = PORT;

function shutdown(code = 0) {
  if (state.stopping) return;
  state.stopping = true;
  setStatus('stopped', 'shutting down');
  clearTimeout(restartTimer);
  if (state.child) killTree(state.child.pid);
  bridge.cancelWaiters();
  server.close();
  setTimeout(() => process.exit(code), 200).unref();
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('SIGBREAK', () => shutdown(0));
process.on('exit', () => {
  if (state.child) killTree(state.child.pid);
});
process.on('uncaughtException', (e) => {
  log('uncaught', e.stack || e.message);
});

server.listen(PORT, HOST, () => {
  listenPort = server.address().port;
  log('launcher listening', `${HOST}:${listenPort}`, 'data', DATA_DIR, 'signed', PROXY_SECRET ? 'yes' : 'no');
  console.log(JSON.stringify({ event: 'listening', port: listenPort, pid: process.pid }));
  launchServer();
});
