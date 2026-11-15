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
import { parseCodeVersion, findServerBuild, serverMetadataUrl, nodeExeName } from './lib/discovery.mjs';
import { buildServerArgs, buildServerEnv, workbenchUrl, terminalEnvSettings } from './lib/args.mjs';
import { verifyProxySignature, checkBridgeSecret, randomSecret, PROXY_HEADER, BRIDGE_HEADER } from './lib/auth.mjs';
import { matchRoute, parseOpenRequest, fileMenuToCommand } from './lib/router.mjs';
import { Bridge } from './lib/bridge.mjs';
import { BRIDGE_ID, bridgeFolderName, upsertBridgeEntry, staleBridgeFolders } from './lib/extensions.mjs';
import { createFrameProxy, isLoopbackHost, upgradeAllowed } from './lib/frameproxy.mjs';
import { RetryPolicy } from './lib/retry.mjs';
import { windowsUserEnv } from './lib/userenv.mjs';
import { provisionServer } from './lib/provision.mjs';
import { resolveTheme, toVsCodeTheme, themeSignature, seedThemeSettings } from './lib/theme.mjs';
import { GatewayClient, CHAT_PERMISSIONS, PERMISSION_MESSAGE, slotNameFor, folderSlotTitle } from './lib/gateway.mjs';
import { parseChatRequest, parseNativeChatRequest, runChatTurn, runNativeTurn, folderInRoots } from './lib/chatbridge.mjs';
import { SessionRegistry, newSessionSlotName, sessionTitle, historyTurns, APPROVE_IN_KIRO_CREW } from './lib/nativechat.mjs';
import { chatSettings, parseChatPrefs, DEFAULT_CHAT_PREFS } from './lib/chatprefs.mjs';
import { parseFrameState, frameStateFor, frameStateHasKey, serializeFrameState } from './lib/framestate.mjs';

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
fs.mkdirSync(path.join(DATA_DIR, 'state'), { recursive: true });
const logStream = fs.createWriteStream(path.join(DATA_DIR, 'logs', 'launcher.log'), { flags: 'a' });
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  logStream.write(line + '\n');
  if (env.VSCODE_PANE_VERBOSE === '1') console.log(line);
}

// Config precedence: env > data/config.json > <app root>/dev-config.json.
// dev-config.json is written by scripts/stage.mjs for a local install and is
// never committed.
function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}
function readJsonFile(p) {
  try {
    return parseConfig(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}
const fileConfig = {
  ...readJsonFile(path.join(APP_ROOT, 'dev-config.json')),
  ...readJsonFile(path.join(DATA_DIR, 'config.json')),
};
const config = effectiveConfig(fileConfig, env, { homedir: os.homedir(), appRoot: APP_ROOT });

// The frame's port persists in data/state/frame.json so the VS Code origin,
// and with it the browser-side state, survives launcher restarts. The path key
// is new each run and stays in memory (see lib/framestate.mjs).
const FRAME_STATE_FILE = path.join(DATA_DIR, 'state', 'frame.json');
const frameStateText = readText(FRAME_STATE_FILE);
const frameState = frameStateFor(parseFrameState(frameStateText));
const FRAME_KEY = frameState.key;
const BASE_PATH = `/vsc-${FRAME_KEY}`;
// Identifies this launcher run in /api/session; the page reloads its kept-alive
// frame when it changes.
const RUN_ID = randomSecret(9);
const BRIDGE_SECRET = randomSecret(24);
// One connection token per launcher run, not per server start: the workbench
// keeps the token from its config, so a reload after a server restart must
// not need a new one. A launcher restart gives a new frame path and token.
const CONNECTION_TOKEN = randomSecret(24);
const bridge = new Bridge();
const retry = new RetryPolicy();

// Kiro Crew gateway access for the built-in Chat, with this app's own token.
const gateway = new GatewayClient({
  origin: env.KIROCREW_GATEWAY_ORIGIN || '',
  appName: env.KIROCREW_APP_NAME || 'vscode-pane',
  secret: PROXY_SECRET,
  log,
});
const chatStats = { turns: 0, lastTurn: null, active: 0 };

// One Kiro Crew slot per VS Code chat session of the "Kiro Crew" session type.
const sessions = new SessionRegistry({ file: path.join(DATA_DIR, 'state', 'chat-sessions.json') });
// Whether Copilot's own agents (local harness, Cloud, Copilot CLI) are hidden
// so new chats open as Kiro Crew sessions. Mirrors the VS Code setting
// kiroCrew.chat.hideCopilotAgents, which the extension reports.
const CHAT_PREFS_FILE = path.join(DATA_DIR, 'state', 'chat-prefs.json');
let chatPrefs = parseChatPrefs(readText(CHAT_PREFS_FILE));

// The Kiro Crew palette applied to VS Code (POST /api/theme), kept in data/state/theme.json.
const THEME_FILE = path.join(DATA_DIR, 'state', 'theme.json');
// Two tiers: "palette" (Kiro Crew colours over the base theme) or "base"
// (stock Dark Modern / Light Modern only); see lib/theme.mjs resolveTheme.
let theme = null; // {kind, vars|null, tier, reason, updatedAt}
let vsTheme = null; // {colorTheme, colorCustomizations, tier}
{
  let saved = null;
  try {
    saved = JSON.parse(readText(THEME_FILE) || 'null');
  } catch {
    saved = null;
  }
  const v = saved && typeof saved === 'object' ? resolveTheme({ kind: saved.kind, vars: saved.vars ?? undefined }) : null;
  if (v && v.theme) {
    const reason = v.theme.tier === 'base' && typeof saved.reason === 'string' ? saved.reason.slice(0, 300) : v.theme.reason;
    theme = { ...v.theme, reason, updatedAt: typeof saved.updatedAt === 'string' ? saved.updatedAt : null };
    vsTheme = toVsCodeTheme(v.theme);
  }
}

function themeCommand() {
  return { kind: 'applyTheme', theme: { ...vsTheme, signature: themeSignature(vsTheme) } };
}

const state = {
  status: 'idle', // idle | provisioning | starting | ready | error | stopped
  message: '',
  error: null,
  build: null, // {dir, source, commit}
  serverPort: 0,
  token: null,
  child: null,
  startedAt: null,
  generation: 0, // bumps every time a server becomes ready; the UI reloads its frame on change
  autoRetry: true,
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

function provisionError(message) {
  return Object.assign(new Error(message), { kind: 'provision' });
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
        metadataUrl: serverMetadataUrl(commit),
        dataDir: DATA_DIR,
        commit,
        onStatus: (m) => setStatus('provisioning', m),
      });
      return { dir, source: 'download', commit };
    } catch (e) {
      if (!found) throw provisionError(`VS Code server download failed: ${e.message}`);
      log('download failed, using older build', e.message);
    }
  }
  if (found) return found;
  throw provisionError(
    commit
      ? 'No VS Code server build found and downloads are disabled. Set serverDir in data/config.json.'
      : 'No VS Code server build found and the `code` CLI is not available to say which build to download. Set serverDir in data/config.json.',
  );
}

// The user's logon environment for the server (Windows), read once per run.
let userEnvCache;
function serverUserEnv() {
  if (userEnvCache !== undefined) return userEnvCache;
  userEnvCache = process.platform === 'win32' ? windowsUserEnv(env) : null;
  log('server env', userEnvCache ? `user logon environment (${Object.keys(userEnvCache).length} variables)` : 'launcher environment');
  return userEnvCache;
}

// The chat settings the launcher writes, and how hideCopilotAgents changes
// them, are in lib/chatprefs.mjs (chatSettings).

/**
 * The server's Machine settings.json: terminals unset the gateway tracking and
 * bridge variables, the Kiro Crew theme is seeded so the first paint is
 * already themed, and Copilot's sign-in prompts are turned down.
 */
function writeMachineSettings() {
  const dir = path.join(DATA_DIR, 'server-data', 'data', 'Machine');
  const file = path.join(dir, 'settings.json');
  fs.mkdirSync(dir, { recursive: true });
  const existing = readText(file);
  const withTerminal = terminalEnvSettings(existing);
  const next = withTerminal === null ? null : seedThemeSettings(withTerminal, vsTheme, chatSettings(chatPrefs));
  if (next === null) log('Machine settings.json is not plain JSON; left unchanged');
  else if (next !== existing) fs.writeFileSync(file, next);
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
  // The app icon doubles as the chat participant's avatar.
  const icon = path.join(APP_ROOT, 'assets', 'icon.png');
  if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(dest, 'icon.png'));
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
let restartPending = false;

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
    writeMachineSettings();
    const port = await freePort();
    const tokenFile = path.join(DATA_DIR, 'run', 'connection-token');
    fs.writeFileSync(tokenFile, CONNECTION_TOKEN, { mode: 0o600 });
    fs.mkdirSync(path.join(DATA_DIR, 'server-data'), { recursive: true });
    const args = buildServerArgs({
      port,
      tokenFile,
      dataDir: DATA_DIR,
      workspace: fs.existsSync(config.workspace) ? config.workspace : null,
      basePath: BASE_PATH,
      proposedApiFor: [BRIDGE_ID],
    });
    const childEnv = buildServerEnv(env, {
      bridgeUrl: `http://${HOST}:${listenPort}`,
      bridgeSecret: BRIDGE_SECRET,
      userEnv: serverUserEnv(),
    });
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
    state.token = CONNECTION_TOKEN;
    log('server spawned pid', child.pid, 'port', port);
    child.on('exit', (code, signal) => {
      log('server exited', code, signal);
      serverLog.end();
      if (state.child === child) {
        state.child = null;
        state.serverPort = 0;
        state.token = null;
        bridge.resetConnection();
      }
      // Exits before "ready" are handled by the launch's own failure path.
      if (!state.stopping && !child.__replaced && child.__ready) onCrash(`VS Code server exited (${code ?? signal})`);
    });
    child.on('error', (e) => log('server spawn error', e.message));
    const ok = await waitReady(port, child);
    if (!ok) {
      killTree(child.pid);
      throw new Error('VS Code server did not become ready; see data/logs/vscode-server.log');
    }
    child.__ready = true;
    state.startedAt = new Date().toISOString();
    state.generation += 1;
    state.autoRetry = true;
    retry.recordSuccess();
    setStatus('ready', 'VS Code is running');
  } catch (e) {
    const decision = retry.recordStartFailure(e.kind);
    if (decision.retry) {
      setStatus('error', 'VS Code server failed to start', `${e.message} (retrying in ${Math.round(decision.delayMs / 1000)} s)`);
      scheduleRestart(decision.delayMs);
    } else {
      stopRetrying(decision.reason, e.message);
    }
  } finally {
    launching = false;
    if (restartPending && !state.stopping) {
      restartPending = false;
      restartServer();
    }
  }
}

function stopRetrying(reason, detail) {
  state.autoRetry = false;
  setStatus('error', `Stopped: ${reason}`, `${detail} Use Restart server to try again.`);
}

function onCrash(reason) {
  const decision = retry.recordCrash();
  if (!decision.retry) return stopRetrying(decision.reason, reason + '.');
  setStatus('starting', `${reason}; restarting in ${Math.round(decision.delayMs / 1000)} s`);
  scheduleRestart(decision.delayMs);
}

function scheduleRestart(delayMs) {
  if (state.stopping || restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    launchServer();
  }, delayMs);
  restartTimer.unref?.();
}

/** Manual restart (UI "Restart server" / "Try again"): resets the retry budget. */
async function restartServer() {
  if (launching) {
    restartPending = true; // applied when the launch in flight settles
    return;
  }
  const old = state.child;
  if (old) {
    old.__replaced = true;
    killTree(old.pid);
  }
  state.child = null;
  state.serverPort = 0;
  state.token = null;
  bridge.resetConnection();
  clearTimeout(restartTimer);
  restartTimer = null;
  retry.reset();
  state.autoRetry = true;
  await launchServer();
}

// ---------------------------------------------------------------------------
// HTTP

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
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


function sessionBody(folderParam) {
  const folder = folderParam || (fs.existsSync(config.workspace) ? config.workspace : null);
  const ready = state.status === 'ready' && !!state.serverPort;
  return {
    status: state.status,
    ready,
    message: state.message,
    error: state.error,
    url: ready && framePort ? workbenchUrl({ host: HOST, port: framePort, basePath: BASE_PATH, folder }) : null,
    folder,
    defaultFolder: config.workspace,
    generation: state.generation,
    instance: RUN_ID,
    autoRetry: state.autoRetry,
    server: state.build ? { source: state.build.source, commit: state.build.commit, startedAt: state.startedAt } : null,
    bridge: { connected: bridge.connected, extension: bridge.extension },
    theme: theme ? { kind: theme.kind, tier: theme.tier } : null,
    chat: chatProblem(),
    // For the docked Kiro Crew chat column (ui/, round 3): the page toggles the
    // column whenever crewChatToggle (an integer) changes, and crewSlot is the
    // folder's own slot {key, folder, title}. The column lists the per-session
    // slots itself from GET /api/chat/slots (the app's own slots, with project).
    crewChatToggle: bridge.crewChatToggle,
    crewSlot: folder ? { key: slotNameFor(folder), folder, title: folderSlotTitle(folder) } : null,
  };
}

/** What the page shows about chat: null when nothing needs the user, else {code, message}. */
function chatProblem() {
  if (gateway.permissionDenied) return { code: 'permission', message: PERMISSION_MESSAGE, needed: CHAT_PERMISSIONS };
  return null;
}

function themeBody() {
  return {
    theme: theme ? { kind: theme.kind, tier: theme.tier, reason: theme.reason, vars: theme.vars, updatedAt: theme.updatedAt } : null,
    colorTheme: vsTheme ? vsTheme.colorTheme : null,
    signature: vsTheme ? themeSignature(vsTheme) : null,
    applied: bridge.theme,
  };
}

async function chatStatusBody(probe) {
  const reason = gateway.unavailableReason;
  let probed = null;
  if (probe && !reason) {
    try {
      const st = await gateway.status();
      probed = { reachable: true, version: st.version };
    } catch (e) {
      probed = { reachable: false, lastError: e.message };
    }
  }
  const denied = gateway.permissionDenied;
  const out = {
    available: !reason && !denied,
    reason: reason || (denied ? PERMISSION_MESSAGE : null),
    permission: denied ? { denied: true, path: denied.path, at: denied.at, needed: CHAT_PERMISSIONS } : { denied: false },
    gateway: {
      origin: gateway.origin || null,
      token: gateway.tokenValue ? { exchangedAt: gateway.lastTokenAt, expiresAt: gateway.tokenExpiresAt() } : null,
      lastError: gateway.lastError,
    },
    extension: {
      connected: bridge.connected,
      chat: bridge.extension ? bridge.extension.chat : null,
    },
    turns: chatStats.turns,
    activeTurns: chatStats.active,
    lastTurn: chatStats.lastTurn,
    native: {
      prefs: chatPrefs,
      vscodePrefs: bridge.chatPrefs,
      approvalGrant: gateway.approvalGrant,
      sessions: sessions.list().length,
      events: bridge.sessionEvents.slice(-20),
    },
  };
  if (probed) {
    Object.assign(out.gateway, probed);
    out.gateway.token = gateway.tokenValue ? { exchangedAt: gateway.lastTokenAt, expiresAt: gateway.tokenExpiresAt() } : null;
  }
  return out;
}

/** The folders this VS Code window has open (or the default workspace when none). */
function windowRoots() {
  return bridge.extension?.workspaceFolders?.length ? bridge.extension.workspaceFolders : [config.workspace];
}

/** A registered session whose folder this window has open, or null. */
function sessionFor(slot) {
  if (typeof slot !== 'string') return null;
  const s = sessions.get(slot);
  return s && folderInRoots(s.folder, windowRoots()) ? s : null;
}

/**
 * Apply hideCopilotAgents: keep it in data/state/chat-prefs.json and rewrite
 * the server's Machine settings, which the workbench picks up live.
 */
function applyChatPrefs(next, source) {
  const merged = { ...DEFAULT_CHAT_PREFS, ...chatPrefs, ...next };
  if (merged.hideCopilotAgents === chatPrefs.hideCopilotAgents) return false;
  chatPrefs = merged;
  fs.writeFileSync(CHAT_PREFS_FILE, JSON.stringify(chatPrefs, null, 2) + '\n');
  writeMachineSettings();
  log('chat prefs', JSON.stringify(chatPrefs), 'from', source);
  return true;
}

/** POST /api/bridge/chat with a slot: a turn of a Kiro Crew session type session. */
async function nativeChat(raw, res) {
  const parsed = parseNativeChatRequest(raw, { defaultFolder: windowRoots()[0] || null });
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });
  const s = sessionFor(parsed.slot);
  if (!s) return sendJson(res, 404, { error: 'unknown session' });
  if (!folderInRoots(parsed.folder, windowRoots())) return sendJson(res, 403, { error: 'folder is not open in this VS Code window' });
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  const write = (part) => {
    if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(part) + '\n');
  };
  chatStats.active++;
  const startedAt = new Date().toISOString();
  try {
    sessions.touch(s.slot, { title: parsed.prompt });
    const r = await runNativeTurn({ gateway, prompt: parsed.prompt, folder: s.folder, slot: s.slot, title: `VS Code: ${s.title}`, signal: ac.signal, write, log });
    chatStats.turns++;
    chatStats.lastTurn = { at: startedAt, outcome: r.outcome, slot: r.slot || null, error: r.error || null, native: true, tools: r.tools || 0 };
    log('chat turn (session)', r.outcome, r.slot || '', r.error || '');
  } finally {
    chatStats.active--;
  }
  if (!res.writableEnded) res.end();
}

const frameProxy = createFrameProxy(() =>
  state.status === 'ready' && state.serverPort ? { port: state.serverPort, token: state.token } : null,
);

/** The frame listener serves only the workbench under its key, and only to a loopback Host. */
function handleFrame(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  const route = matchRoute(req.method, url.pathname, BASE_PATH);
  if (route.name !== 'frame') return sendJson(res, 404, { error: 'not found' });
  if (!isLoopbackHost(req.headers.host)) return sendJson(res, 403, { error: 'bad host' });
  return frameProxy.handleRequest(req, res);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  const route = matchRoute(req.method, url.pathname, null);
  if (route.error) return sendJson(res, route.error, { error: route.error === 404 ? 'not found' : 'method not allowed' });

  if (!isLoopbackHost(req.headers.host)) return sendJson(res, 403, { error: 'bad host' });

  let body;
  try {
    body = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req, route.name === 'bridgeChat' ? 256 * 1024 : MAX_BODY);
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
      const host = url.searchParams.get('host');
      if (bridge.isSuperseded(host)) {
        // An older extension host (the pane was remounted): it gets no
        // commands; it is held for the poll interval so it does not spin.
        await new Promise((ok) => {
          const t = setTimeout(ok, wait);
          ac.signal.addEventListener('abort', () => {
            clearTimeout(t);
            ok();
          });
        });
        return sendJson(res, 200, { commands: [], superseded: true });
      }
      const batch = await bridge.take(wait, ac.signal);
      if (res.destroyed || res.writableEnded) {
        bridge.requeue(batch);
        return;
      }
      return sendJson(res, 200, { commands: batch });
    }
    case 'bridgeEvents': {
      const ev = parseJson(body);
      const hostBefore = bridge.currentHost;
      const extensionBefore = bridge.extension;
      if (!bridge.applyEvent(ev)) return sendJson(res, 400, { error: 'unknown event' });
      // A new extension host (first start, a reload, a remount of the pane, a
      // server restart) gets the current theme once; it writes it only if it
      // differs. A repeated hello from the same host does not resend it.
      const newHost = ev.type === 'hello' && (!extensionBefore || !ev.host || ev.host !== hostBefore);
      if (newHost && vsTheme) bridge.enqueueLatest(themeCommand());
      if (ev.type === 'chatPrefs') applyChatPrefs({ hideCopilotAgents: ev.hideCopilotAgents }, 'vscode');
      res.writeHead(204);
      return res.end();
    }
    case 'themeGet':
      return sendJson(res, 200, themeBody());
    case 'theme': {
      const parsed = parseJson(body);
      if (parsed === undefined) return sendJson(res, 400, { error: 'body is not JSON' });
      const v = resolveTheme(parsed, body.length);
      if (v.error) return sendJson(res, v.error.includes('bytes') ? 413 : 400, { error: v.error });
      const next = toVsCodeTheme(v.theme);
      const changed = !vsTheme || themeSignature(next) !== themeSignature(vsTheme);
      if (changed) {
        theme = { ...v.theme, updatedAt: new Date().toISOString() };
        vsTheme = next;
        fs.writeFileSync(THEME_FILE, JSON.stringify(theme, null, 2) + '\n');
        writeMachineSettings();
        bridge.enqueueLatest(themeCommand());
        log('theme updated', theme.kind, 'tier', theme.tier, theme.reason || '');
      } else if (theme && theme.reason !== v.theme.reason) {
        theme = { ...theme, reason: v.theme.reason };
      }
      return sendJson(res, 200, { ok: true, changed, ...themeBody() });
    }
    case 'chatStatus':
      return sendJson(res, 200, await chatStatusBody(url.searchParams.get('probe') === '1'));
    case 'chatAsk': {
      const parsed = parseJson(body);
      const prompt = parsed && typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
      if (!prompt || prompt.length > 4000) return sendJson(res, 400, { error: 'prompt is required (at most 4000 characters)' });
      const { id, done } = bridge.enqueue({ kind: 'askChat', prompt, ...(parsed.newChat === true ? { newChat: true } : {}) }, 8000);
      const result = await done;
      return sendJson(res, 200, { id, ...result, bridgeConnected: bridge.connected });
    }
    case 'chatPrefsGet':
      return sendJson(res, 200, { prefs: chatPrefs, vscode: bridge.chatPrefs, settings: chatSettings(chatPrefs) });
    case 'chatPrefs': {
      // Changes the VS Code setting itself (the extension writes it); the
      // setting's change then comes back as a chatPrefs event and is applied.
      const parsed = parseJson(body);
      if (!parsed || typeof parsed.hideCopilotAgents !== 'boolean' || Object.keys(parsed).length !== 1) {
        return sendJson(res, 400, { error: 'body must be {hideCopilotAgents: boolean}' });
      }
      const { id, done } = bridge.enqueue({ kind: 'setChatPrefs', prefs: { hideCopilotAgents: parsed.hideCopilotAgents } }, 8000);
      const result = await done;
      if (!result.ok) applyChatPrefs(parsed, 'api'); // no VS Code window: apply for the next start
      return sendJson(res, 200, { id, ...result, prefs: chatPrefs });
    }
    case 'chatOpenSession': {
      // Opens a Kiro Crew chat session in VS Code's Chat (by its slot).
      const parsed = parseJson(body);
      const s = sessionFor(parsed && parsed.slot);
      if (!s) return sendJson(res, 404, { error: 'unknown session' });
      const { id, done } = bridge.enqueue({ kind: 'openChatSession', slot: s.slot }, 12000);
      return sendJson(res, 200, { id, ...(await done), bridgeConnected: bridge.connected });
    }
    case 'bridgeSessions': {
      const roots = windowRoots();
      return sendJson(res, 200, { sessions: sessions.list((f) => folderInRoots(f, roots)) });
    }
    case 'bridgeSessionCreate': {
      const parsed = parseJson(body);
      const folder = parsed && typeof parsed.folder === 'string' ? parsed.folder : '';
      if (!folder || !path.isAbsolute(folder) || !folderInRoots(folder, windowRoots())) return sendJson(res, 403, { error: 'folder is not open in this VS Code window' });
      const title = sessionTitle(parsed.title);
      const slot = newSessionSlotName(folder);
      try {
        await gateway.ensureSlotNamed({ name: slot, title: `VS Code: ${title}`, folder });
      } catch (e) {
        return sendJson(res, e.code === 'permission' ? 403 : 502, { error: e.message, code: e.code || '' });
      }
      const s = sessions.add({ slot, folder, title });
      log('chat session created', slot);
      return sendJson(res, 200, { session: s });
    }
    case 'bridgeSessionHistory': {
      const s = sessionFor(url.searchParams.get('slot'));
      if (!s) return sendJson(res, 404, { error: 'unknown session' });
      try {
        const detail = await gateway.slotDetail(s.slot, 400);
        return sendJson(res, 200, { session: s, running: !!detail?.running, turns: historyTurns(detail?.messages) });
      } catch (e) {
        // A slot closed in Kiro Crew has no history to show; the next turn recreates it.
        return sendJson(res, 200, { session: s, running: false, turns: [], error: e.message, gone: e.status === 404 });
      }
    }
    case 'bridgeApprove': {
      const parsed = parseJson(body);
      const s = sessionFor(parsed && parsed.slot);
      if (!s) return sendJson(res, 404, { error: 'unknown session' });
      const action = parsed.action;
      const requestId = parsed.requestId;
      if (!['approved', 'rejected'].includes(action) || typeof requestId !== 'string' || !requestId || requestId.length > 256) {
        return sendJson(res, 400, { error: 'body must be {slot, requestId, action: "approved"|"rejected"}' });
      }
      try {
        const r = await gateway.approve(s.slot, { requestId, action });
        log('chat approval', s.slot, action, r.ok ? 'ok' : `${r.status} ${r.code}`);
        if (r.code === 'session_approval_not_granted') return sendJson(res, 200, { ...r, message: r.error || APPROVE_IN_KIRO_CREW });
        return sendJson(res, 200, r);
      } catch (e) {
        return sendJson(res, 502, { ok: false, error: e.message });
      }
    }
    case 'bridgeQuestion': {
      const parsed = parseJson(body);
      const s = sessionFor(parsed && parsed.slot);
      if (!s) return sendJson(res, 404, { error: 'unknown session' });
      const askId = parsed.askId;
      const answers = parsed.answers;
      const okAnswers = answers && typeof answers === 'object' && !Array.isArray(answers) && Object.values(answers).every((v) => typeof v === 'string' && v.length <= 2000);
      if (typeof askId !== 'string' || !askId || (!parsed.dismissed && !okAnswers)) return sendJson(res, 400, { error: 'body must be {slot, askId, answers} or {slot, askId, dismissed: true}' });
      try {
        return sendJson(res, 200, await gateway.answerQuestion(s.slot, { askId, answers, dismissed: parsed.dismissed === true }));
      } catch (e) {
        return sendJson(res, 502, { ok: false, error: e.message });
      }
    }
    case 'bridgeChat': {
      const raw = parseJson(body);
      if (raw && raw.slot !== undefined) return nativeChat(raw, res);
      const parsed = parseChatRequest(raw, {
        defaultFolder: bridge.extension?.workspaceFolders?.[0] || (fs.existsSync(config.workspace) ? config.workspace : null),
      });
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      // A chat turn runs Kiro Crew with tools in the folder, so only a folder
      // this VS Code window has open (or the default workspace when none is).
      const roots = bridge.extension?.workspaceFolders?.length ? bridge.extension.workspaceFolders : [config.workspace];
      if (!folderInRoots(parsed.folder, roots)) return sendJson(res, 403, { error: 'folder is not open in this VS Code window' });
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
      const ac = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) ac.abort();
      });
      const write = (part) => {
        if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(part) + '\n');
      };
      chatStats.active++;
      const startedAt = new Date().toISOString();
      try {
        const r = await runChatTurn({ gateway, prompt: parsed.prompt, folder: parsed.folder, signal: ac.signal, write, log });
        chatStats.turns++;
        chatStats.lastTurn = { at: startedAt, outcome: r.outcome, slot: r.slot || null, error: r.error || null };
        log('chat turn', r.outcome, r.slot || '', r.error || '');
      } finally {
        chatStats.active--;
      }
      if (!res.writableEnded) res.end();
      return;
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
// The API port never upgrades; the workbench socket lives on the frame port.
server.on('upgrade', (_req, socket) => socket.destroy());

const frameServer = http.createServer((req, res) => {
  try {
    handleFrame(req, res);
  } catch (e) {
    log('frame handler error', e.stack || e.message);
    sendJson(res, 500, { error: 'internal error' });
  }
});
frameServer.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  if (p !== BASE_PATH && !p.startsWith(BASE_PATH + '/')) return socket.destroy();
  if (!upgradeAllowed({ host: req.headers.host, origin: req.headers.origin, listenPort: framePort })) {
    log('refused WebSocket upgrade', `host=${String(req.headers.host).slice(0, 80)}`, `origin=${String(req.headers.origin).slice(0, 80)}`);
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  return frameProxy.handleUpgrade(req, socket, head);
});
// Long polls and VS Code's long-lived requests must not be cut by Node's defaults.
for (const s of [server, frameServer]) {
  s.requestTimeout = 0;
  s.headersTimeout = 60_000;
  s.keepAliveTimeout = 5_000;
}

let listenPort = PORT;
let framePort = 0;

/** Bind the frame listener to its saved port, or a free one when that is taken; save what we got. */
function listenFrame(preferred) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, fallback) => {
      const onError = (e) => {
        frameServer.off('listening', onListening);
        if (fallback && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) {
          log('frame port', p, 'unavailable', e.code, '- picking a new one');
          tryPort(0, false);
        } else reject(e);
      };
      const onListening = () => {
        frameServer.off('error', onError);
        resolve(frameServer.address().port);
      };
      frameServer.once('error', onError);
      frameServer.once('listening', onListening);
      frameServer.listen(p, HOST);
    };
    tryPort(preferred || 0, !!preferred);
  });
}

function shutdown(code = 0) {
  if (state.stopping) return;
  state.stopping = true;
  setStatus('stopped', 'shutting down');
  clearTimeout(restartTimer);
  if (state.child) killTree(state.child.pid);
  bridge.cancelWaiters();
  server.close();
  frameServer.close();
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

server.listen(PORT, HOST, async () => {
  listenPort = server.address().port;
  try {
    framePort = await listenFrame(frameState.port);
  } catch (e) {
    log('frame listener failed', e.message);
    setStatus('error', 'Could not open the VS Code frame port', e.message);
    return;
  }
  if (framePort !== frameState.port || !fs.existsSync(FRAME_STATE_FILE) || frameStateHasKey(frameStateText)) {
    fs.writeFileSync(FRAME_STATE_FILE, serializeFrameState({ port: framePort }), { mode: 0o600 });
  }
  log('launcher listening', `${HOST}:${listenPort}`, 'frame', `${HOST}:${framePort}`, framePort === frameState.port ? '(saved port)' : '(new port)', 'data', DATA_DIR, 'signed', PROXY_SECRET ? 'yes' : 'no');
  console.log(JSON.stringify({ event: 'listening', port: listenPort, framePort, pid: process.pid }));
  launchServer();
  // One early gateway call, so an Update whose new chat permissions are not
  // approved yet shows in the page before anyone tries chat.
  if (!gateway.unavailableReason) {
    gateway.status().catch((e) => log('gateway probe at start:', e.message));
  }
});
