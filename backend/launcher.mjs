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
import { parseCodeVersion, findServerBuild, serverMetadataUrl, serverLatestMetadataUrl, nodeExeName } from './lib/discovery.mjs';
import { buildServerArgs, buildServerEnv, workbenchUrl, terminalEnvSettings } from './lib/args.mjs';
import { verifyProxySignature, checkBridgeSecret, randomSecret, PROXY_HEADER, BRIDGE_HEADER } from './lib/auth.mjs';
import { matchRoute, parseOpenRequest, fileMenuToCommand } from './lib/router.mjs';
import { Bridge } from './lib/bridge.mjs';
import { BRIDGE_ID, bridgeFolderName, upsertBridgeEntry, staleBridgeFolders } from './lib/extensions.mjs';
import { createFrameProxy, isLoopbackHost, isWebviewHost, isWebOriginHost, webviewRequestAllowed, upgradeAllowed } from './lib/frameproxy.mjs';
import { MINT_PATH, loadServerHalf, clientHalfFrom, mintKey, mintAllowed, viewerCookieHeader, viewerOk } from './lib/secretkey.mjs';
import { overlayScript } from './lib/overlay.mjs';
import { diagnose, addAllowedPort, listedPorts, validPort, PORTS_VAR } from './lib/weborigin.mjs';
import { parseCrewViewRequest, parseSecretProbe } from './lib/crewview.mjs';
import { createKcProxy } from './lib/kcproxy.mjs';
import { signInWithLocalToken, dataHome } from './lib/localtoken.mjs';
import { tunnelCss } from './lib/chipcss.mjs';
import { layoutSettings } from './lib/layoutprefs.mjs';
import { dashboardOrigins, overlayTabBody, embedPathFor } from './lib/kctab.mjs';
import { TabStore, validTabId, validSessionKey, validFolder, sameFolder } from './lib/tabs.mjs';
import { workspaceFileFinder } from './lib/workspacefile.mjs';
import { RetryPolicy } from './lib/retry.mjs';
import { windowsUserEnv } from './lib/userenv.mjs';
import { provisionServer, fetchJson } from './lib/provision.mjs';
import { ownedBuild, buildName, readRecord, writeRecord, recordedDir, decideUpdate, removableBuilds, updateBase, COMMIT_RE } from './lib/serverbuild.mjs';
import { resolveTheme, toVsCodeTheme, themeSignature, seedThemeSettings, bootCss, bootColors } from './lib/theme.mjs';
import { GatewayClient, CHAT_PERMISSIONS, PERMISSION_MESSAGE } from './lib/gateway.mjs';
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
// The app's name as the gateway knows it; its web origin (backend.webOrigin) is
// <name>.apps.localhost, which the gateway relays to this port.
const APP_NAME = env.KIROCREW_APP_NAME || 'vscode-pane';
// The page's probe of whether this machine's frame port is reachable from its browser.
const PROBE_PATH = '/_vscp-probe';
// The build record: which VS Code server build the app installed last, and the one it replaced.
const BUILD_RECORD = path.join(DATA_DIR, 'state', 'server-build.json');
// The update service. VSCODE_PANE_UPDATE_BASE moves it to a loopback stand-in (for tests).
const UPDATE_BASE = updateBase(env.VSCODE_PANE_UPDATE_BASE);
const UPDATE_HTTP = UPDATE_BASE.startsWith('http://');
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
// What the gateway-relay diagnosis asks for on the web origin (lib/weborigin.mjs).
const WEB_PROBE_PATH = `${BASE_PATH}/_vscp-probe`;
// Identifies this launcher run in /api/session; the page reloads its kept-alive
// frame when it changes.
const RUN_ID = randomSecret(9);
const BRIDGE_SECRET = randomSecret(24);
// Sets, HttpOnly, on the workbench page served on the web origin; the chat on that origin needs it.
const VIEWER_SECRET = randomSecret(24);
// One connection token per launcher run, not per server start: the workbench
// keeps the token from its config, so a reload after a server restart must
// not need a new one. A launcher restart gives a new frame path and token.
const CONNECTION_TOKEN = randomSecret(24);
const bridge = new Bridge();
const retry = new RetryPolicy();

// The server half of the workbench's secret-storage key (lib/secretkey.mjs),
// kept in data/state/secret-key-half so stored secrets (GitHub sign-in)
// survive page reloads and launcher restarts. Never logged, never put in an
// environment variable or a command line.
const SECRET_HALF_FILE = path.join(DATA_DIR, 'state', 'secret-key-half');
const secretHalf = loadServerHalf(SECRET_HALF_FILE);

// Kiro Crew gateway access for the built-in Chat, with this app's own token.
const gateway = new GatewayClient({
  origin: env.KIROCREW_GATEWAY_ORIGIN || '',
  appName: APP_NAME,
  secret: PROXY_SECRET,
  log,
});
const chatStats = { turns: 0, lastTurn: null, active: 0 };

// One Kiro Crew slot per VS Code chat session of the "Kiro Crew" session type.
const sessions = new SessionRegistry({ file: path.join(DATA_DIR, 'state', 'chat-sessions.json') });
// The page's tabs, one VS Code window each (lib/tabs.mjs).
const tabs = new TabStore({ file: path.join(DATA_DIR, 'state', 'tabs.json'), onError: (e) => log('could not save the tabs', e.message) });
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

// How the browser that last loaded the workbench reached it: 'frame' (the frame
// port) or 'origin' (the app web origin, a remote crew's tunnel).
const viewer = { via: 'frame' };

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
  // Set when no server build exists and the `code` command is not here to name
  // one: the page then offers a button that downloads the latest stable build.
  needsInstall: false,
  installing: false,
  // The page's update check and update: {phase, installed, latest, message, error, at}.
  update: null,
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
  // With no `code` command to name a build, the build the app recorded as installed (its last download or update), while it is still there.
  if (!commit && !config.serverDir) {
    const dir = recordedDir({ dataDir: DATA_DIR, commit: (readRecord(BUILD_RECORD) || {}).commit });
    if (dir) return { dir, source: 'data', commit: path.basename(dir) };
  }
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
        metadataUrl: serverMetadataUrl(commit, process.platform, process.arch, UPDATE_BASE),
        dataDir: DATA_DIR,
        commit,
        allowHttp: UPDATE_HTTP,
        onStatus: (m) => setStatus('provisioning', m),
        onInstalled: (m) => recordInstall(m, 'download'),
      });
      return { dir, source: 'download', commit };
    } catch (e) {
      if (!found) throw provisionError(`VS Code server download failed: ${e.message}`);
      log('download failed, using older build', e.message);
    }
  }
  if (found) return found;
  if (!commit && config.allowDownload) {
    // No `code` command on this machine, so no commit to ask for. The user is
    // offered the latest stable build rather than getting a 250 MB download unasked.
    throw Object.assign(
      provisionError(
        'The code command is not available on this machine, so Kiro Crew cannot tell which VS Code server build to use. ' +
          'You can download the latest stable VS Code server (a few hundred MB from update.code.visualstudio.com, checked against its SHA-256) into this app\'s data folder.',
      ),
      { needsInstall: true },
    );
  }
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
 * already themed, Copilot's sign-in prompts are turned down, and the Modern UI
 * density is compact so the parts meet the pane card flush (lib/layoutprefs.mjs).
 */
function writeMachineSettings() {
  const dir = path.join(DATA_DIR, 'server-data', 'data', 'Machine');
  const file = path.join(dir, 'settings.json');
  fs.mkdirSync(dir, { recursive: true });
  const existing = readText(file);
  const withTerminal = terminalEnvSettings(existing);
  const next = withTerminal === null ? null : seedThemeSettings(withTerminal, vsTheme, { ...chatSettings(chatPrefs), ...layoutSettings() });
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
  // The extension ships its own icon.png (the Kiro Crew mark): it is the
  // Extensions-view icon and the chat participant's and sessions' avatar.
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
      state.build.name = buildName(state.build.dir);
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
    settleUpdate();
  } catch (e) {
    if (e.needsInstall) {
      state.needsInstall = true;
      state.autoRetry = false;
      setStatus('error', 'VS Code server is not installed', e.message);
      return;
    }
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
  const rec = readRecord(BUILD_RECORD);
  const back = rec && rec.previous ? recordedDir({ dataDir: DATA_DIR, commit: rec.previous.commit }) : null;
  if (back) {
    // The new build never got a server running: the build it replaced comes back, once.
    try {
      writeRecord(BUILD_RECORD, { commit: rec.previous.commit, name: rec.previous.name, installedAt: rec.installedAt, via: 'rollback', previous: null });
    } catch (e) {
      log('could not roll back the server build', e.message);
      state.autoRetry = false;
      setStatus('error', `Stopped: ${reason}`, `${detail} Use Restart server to try again.`);
      return;
    }
    for (const name of removableBuilds([rec.commit], rec.previous.commit)) {
      try {
        fs.rmSync(path.join(DATA_DIR, 'server', name), { recursive: true, force: true });
      } catch (e) {
        log('could not remove the build that did not start', e.message);
      }
    }
    state.update = {
      phase: 'failed',
      what: 'update',
      installed: { commit: rec.previous.commit, name: rec.previous.name },
      error: `VS Code ${rec.name || rec.commit.slice(0, 8)} did not start (${detail}). The previous build is running again.`,
      at: new Date().toISOString(),
    };
    state.build = null;
    state.autoRetry = true;
    retry.reset();
    restartServer();
    return;
  }
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

/**
 * "Download VS Code server" (the page's button): fetch the latest stable build
 * into data/server/<commit>, then start it. Only runs when the launcher found no
 * build and no `code` command (state.needsInstall); a failure leaves the button
 * in place, and nothing is retried on its own.
 */
async function installLatestServer() {
  if (state.installing || launching || state.stopping) return false;
  state.installing = true;
  try {
    setStatus('provisioning', 'Looking up VS Code server download');
    await provisionServer({
      metadataUrl: serverLatestMetadataUrl(process.platform, process.arch, UPDATE_BASE),
      allowHttp: UPDATE_HTTP,
      onInstalled: (m) => recordInstall(m, 'download'),
      dataDir: DATA_DIR,
      commit: null,
      onStatus: (m) => setStatus('provisioning', m),
    });
  } catch (e) {
    log('server download failed', e.message);
    setStatus('error', 'VS Code server download failed', `${e.message}. Use Download VS Code server to try again.`);
    return false;
  } finally {
    state.installing = false;
  }
  state.needsInstall = false;
  state.build = null;
  await restartServer();
  return true;
}

// ---------------------------------------------------------------- VS Code server updates
//
// A build the app installed (in data/server, or downloaded by the app), with no
// `code` command pinning the server, can be checked for and updated from the page.
// Nothing here runs by itself: each check and each update is the user's click.

/** Record an install: which build the app owns, and (for an update) the one it replaced. */
function recordInstall({ commit, name }, via, previous = null) {
  try {
    writeRecord(BUILD_RECORD, { commit, name: name || null, installedAt: new Date().toISOString(), via, previous });
  } catch (e) {
    log('could not record the server build', e.message);
  }
}

/** The app owns the active build, and no `code` command pins the server to the user's VS Code. */
function serverOwned() {
  return ownedBuild(state.build, codeVersion ? codeVersion.commit : null);
}

/** The newest stable build the update service names, as {commit, name}. */
function latestFrom(meta) {
  const commit = meta && typeof meta.version === 'string' ? meta.version.toLowerCase() : '';
  if (!COMMIT_RE.test(commit)) throw new Error('the update service named no build');
  const name = meta.name || meta.productVersion;
  return { commit, name: typeof name === 'string' && /^\d+\.\d+\.\d+/.test(name) ? name : null };
}

/** Ask the update service for the newest stable build. Changes nothing on disk. */
async function checkServerUpdate() {
  const installed = { commit: state.build.commit, name: state.build.name || null };
  state.update = { phase: 'checking', installed, at: new Date().toISOString() };
  try {
    const meta = await fetchJson(serverLatestMetadataUrl(process.platform, process.arch, UPDATE_BASE), { allowHttp: UPDATE_HTTP });
    const latest = latestFrom(meta);
    const phase = decideUpdate({ installedCommit: installed.commit, latest }).available ? 'available' : 'current';
    state.update = { phase, installed, latest, at: new Date().toISOString() };
  } catch (e) {
    log('server update check failed', e.message);
    state.update = { phase: 'failed', what: 'check', installed, error: `Could not check for updates: ${e.message}`, at: new Date().toISOString() };
  }
  return state.update;
}

/** Download the build the user checked, then switch the server to it. The build it replaces stays until the new one runs. */
async function installServerUpdate(commit) {
  const wasReady = state.status === 'ready';
  const installed = { commit: state.build.commit, name: state.build.name || null };
  const latest = state.update && state.update.latest ? state.update.latest : { commit, name: null };
  const stamp = () => new Date().toISOString();
  state.installing = true;
  state.update = { phase: 'downloading', installed, latest, message: 'Downloading the new VS Code server', at: stamp() };
  try {
    // The server keeps running, and its page keeps the frame, while the download runs.
    const dir = await provisionServer({
      metadataUrl: serverMetadataUrl(commit, process.platform, process.arch, UPDATE_BASE),
      dataDir: DATA_DIR,
      commit,
      allowHttp: UPDATE_HTTP,
      onStatus: (m) => {
        if (state.update && state.update.phase === 'downloading') state.update.message = m;
      },
    });
    const newCommit = path.basename(dir);
    if (newCommit === installed.commit) {
      state.update = { phase: 'current', installed, latest, at: stamp() };
      return;
    }
    const name = buildName(dir) || latest.name || null;
    const previous = { commit: installed.commit, name: installed.name };
    writeRecord(BUILD_RECORD, { commit: newCommit, name, installedAt: stamp(), via: 'update', previous });
    state.update = { phase: 'restarting', installed: { commit: newCommit, name }, previous, at: stamp() };
    state.installing = false;
    state.build = null;
    await restartServer();
  } catch (e) {
    log('server update failed', e.message);
    state.update = { phase: 'failed', what: 'update', installed, latest, error: `The update did not complete: ${e.message}`, at: stamp() };
    if (wasReady && state.status !== 'ready') setStatus('ready', 'VS Code is running');
  } finally {
    state.installing = false;
  }
}

/** The new build is running: the one it replaced is removed, and the record stops naming it. */
function settleUpdate() {
  const rec = readRecord(BUILD_RECORD);
  if (!rec || !rec.previous || !state.build || state.build.commit !== rec.commit) return;
  try {
    for (const name of removableBuilds([rec.previous.commit], rec.commit)) {
      fs.rmSync(path.join(DATA_DIR, 'server', name), { recursive: true, force: true });
    }
    writeRecord(BUILD_RECORD, { ...rec, previous: null });
  } catch (e) {
    log('could not finish the server update record', e.message);
    return;
  }
  if (state.update && state.update.phase === 'restarting') {
    state.update = { phase: 'done', installed: { commit: rec.commit, name: rec.name }, at: new Date().toISOString() };
  }
}

/** Manual restart (UI "Restart server" / "Try again"): resets the retry budget. */
async function restartServer() {
  if (state.installing) return; // the download restarts the server itself when it finishes
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


/** The folder a new tab opens on when the page names none: the configured workspace, else the home folder. */
function defaultFolder() {
  return fs.existsSync(config.workspace) ? config.workspace : os.homedir();
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const workspaceFileOf = workspaceFileFinder();

/**
 * The workbench URL for a folder. A folder that holds a `*.code-workspace` file
 * opens that workspace in place of the folder (lib/workspacefile.mjs picks the
 * file); the tab itself stays on the folder. Read when the URL is built, so a
 * frame that loads later sees a workspace file added since.
 */
function workbenchUrlFor(folder) {
  return workbenchUrl({ host: HOST, port: framePort, basePath: BASE_PATH, folder, workspaceFile: folder ? workspaceFileOf(folder) : null });
}

/** The page's tabs as /api/session reports them: each with its workbench URL once the server is up. */
function tabsBody() {
  const ready = state.status === 'ready' && !!state.serverPort && !!framePort;
  return {
    list: tabs.list().map((t) => ({
      id: t.id,
      folder: t.folder,
      session: t.session,
      url: ready ? workbenchUrlFor(t.folder) : null,
    })),
    active: tabs.active,
    // No tab file yet: the page opens the first tab, on the folder it used last.
    fresh: tabs.fresh,
  };
}

/** The tab a file belongs in: of the tabs whose folder holds it, the one on the deepest folder (then the front tab, then the latest); null when none does. */
function tabHolding(file) {
  const holders = tabs.list().filter((t) => folderInRoots(file, [t.folder]));
  if (!holders.length) return null;
  const depth = (t) => path.resolve(t.folder).length;
  holders.sort((a, b) => depth(b) - depth(a) || Number(b.id === tabs.active) - Number(a.id === tabs.active) || b.activeAt - a.activeAt);
  return tabs.get(holders[0].id);
}

/**
 * The tab to open a file in: `named` when given, else the tab holding the file,
 * else a tab on `root` (the project the file menu names), else the front tab,
 * else a new tab on the file's folder. `{tab}` (tab may be null) or `{error, status}`.
 */
function tabForFile(file, { named = null, root = null } = {}) {
  if (named) return { tab: named };
  const holding = tabHolding(file);
  if (holding) return { tab: holding };
  const base = validFolder(root);
  const folder = base && isDirectory(base) ? base : tabs.get(tabs.active) ? null : path.dirname(file);
  if (!folder) return { tab: tabs.get(tabs.active) };
  if (!isDirectory(folder)) return { tab: null };
  const r = tabs.open({ folder, reuse: true });
  return r.error ? { error: r.error, status: r.status } : { tab: tabs.get(r.tab.id) };
}

/** Where a command for a tab goes (lib/bridge.mjs routes): that tab's window, or before it says so, a window on its folder. */
function tabRoute(t) {
  return t ? { tab: t.id, folder: t.folder } : null;
}

/**
 * The window showing a page tab opened another folder itself (File > Open
 * Folder in VS Code navigates the frame): the tab follows it, so its label and
 * its next load name that folder. Only the tab's newest window counts. A window
 * on a workspace file is on the folder that holds the file, whatever folders the
 * workspace lists, so a tab opened on a folder with a workspace file stays put.
 */
function followWindowFolder(host) {
  const h = bridge.hosts.get(host);
  if (!h || !h.tab || bridge.hostForTab(h.tab) !== host) return;
  const t = tabs.get(h.tab);
  const folder = h.workspaceFile ? path.dirname(h.workspaceFile) : h.folders[0];
  if (!folder) return;
  if (t && !sameFolder(t.folder, folder) && isDirectory(folder) && tabs.setFolder(t.id, folder)) log('tab', t.id, 'follows its window to another folder');
}

function sessionBody(folderParam) {
  const folder = folderParam || (fs.existsSync(config.workspace) ? config.workspace : null);
  const ready = state.status === 'ready' && !!state.serverPort;
  const front = tabs.get(tabs.active);
  return {
    status: state.status,
    ready,
    message: state.message,
    error: state.error,
    // The front tab's workbench (or the default folder's, with no tab); each tab has its own in `tabs`.
    url: ready && framePort ? workbenchUrlFor(front ? front.folder : folder) : null,
    folder,
    defaultFolder: config.workspace,
    generation: state.generation,
    instance: RUN_ID,
    autoRetry: state.autoRetry,
    tabs: tabsBody(),
    // How a page whose browser is not on this machine reaches the workbench:
    // http://<webOriginHost>:<its own dashboard port><the path of `url`>.
    // `gatewayPort` is the dashboard's own port here, which the page names in the
    // port forward it suggests to a viewer that has no route at all.
    webOrigin: { host: `${APP_NAME}.apps.localhost`, probe: PROBE_PATH, gatewayPort: gatewayUrl ? Number(gatewayUrl.port || 80) : null },
    // 'install-server' while the page should offer to download the server.
    action: state.needsInstall && !state.installing ? 'install-server' : null,
    server: state.build ? { source: state.build.source, commit: state.build.commit, name: state.build.name || null, startedAt: state.startedAt, owned: serverOwned() } : null,
    // The page's update check and update: null until the user asks.
    update: state.update,
    bridge: { connected: bridge.connected, extension: bridge.extension },
    theme: theme ? { kind: theme.kind, tier: theme.tier } : null,
    chat: chatProblem(),
    // VS Code's "Kiro Crew" tab as the bridge last reported it.
    crewView: bridge.crewView,
    // The tunnel's sign-in state for the page: never its origin or a cookie.
    kc: kcBody(),
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

/**
 * The folders the calling VS Code window has open (X-Kiro-Bridge-Host names
 * it), or every live window's when it does not, or the default workspace when
 * no window has said hello or the window has no folder.
 */
function windowRoots(host) {
  const roots = bridge.rootsFor(host);
  return roots && roots.length ? roots : [config.workspace];
}

/** A registered session whose folder the calling window has open, or null. */
function sessionFor(slot, host) {
  if (typeof slot !== 'string') return null;
  const s = sessions.get(slot);
  return s && folderInRoots(s.folder, windowRoots(host)) ? s : null;
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
async function nativeChat(raw, res, host) {
  const parsed = parseNativeChatRequest(raw, { defaultFolder: windowRoots(host)[0] || null });
  if (parsed.error) return sendJson(res, 400, { error: parsed.error });
  const s = sessionFor(parsed.slot, host);
  if (!s) return sendJson(res, 404, { error: 'unknown session' });
  if (!folderInRoots(parsed.folder, windowRoots(host))) return sendJson(res, 403, { error: 'folder is not open in this VS Code window' });
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

const frameProxy = createFrameProxy(
  () => (state.status === 'ready' && state.serverPort ? { port: state.serverPort, token: state.token } : null),
  {
    webviewPort: () => framePort,
    secretKey: true,
    // The Kiro Crew palette on the workbench page's first paint, before VS Code loads its own theme.
    boot: () => ({ css: bootCss(theme, vsTheme), colors: bootColors(theme, vsTheme) }),
  },
);

// ------------------------------------------------------------ the Kiro Crew tunnel
//
// The live dashboard on the launcher's own loopback origin (lib/kcproxy.mjs),
// framed by the bridge's "Kiro Crew" view at /embed/chat/<slot>. The session
// cookie stays here; the page and the bridge only learn whether it is connected.
const KC_STATE_FILE = path.join(DATA_DIR, 'state', 'kc-session.json');
const gatewayUrl = (() => {
  try {
    const u = new URL(env.KIROCREW_GATEWAY_ORIGIN || '');
    return u.protocol === 'http:' && isLoopbackHost(u.host) ? u : null;
  } catch {
    return null;
  }
})();
const kcSignIn = { attempts: 0, lastAttempt: null, lastError: null, lastCode: null, via: null, connectRequests: 0 };
const kc = gatewayUrl
  ? createKcProxy({
    gatewayHost: '127.0.0.1',
    gatewayPort: Number(gatewayUrl.port || 80),
    stateFile: KC_STATE_FILE,
    css: () => tunnelCss(bootCss(theme, vsTheme, { scheme: false })),
    // The frame chain: the dashboard, the workbench, the self-hosted webview origins.
    frameAncestors: () => [...dashboardOrigins(env), `http://127.0.0.1:${framePort}`, `http://*.localhost:${framePort}`, `http://${APP_NAME}.apps.localhost:*`],
    log,
    onChange: () => {
      // Every window's Kiro Crew view looks again (signed in or out, or a new origin).
      bridge.broadcast({ kind: 'kcChanged' });
      kcAutoLocalSignIn();
    },
  })
  : null;

function kcBody() {
  if (!kc) return { available: false, connected: false, reason: 'no Kiro Crew gateway address (KIROCREW_GATEWAY_ORIGIN)' };
  return { available: !!kc.port, ...kc.status(), ...kcSignIn, local: { ...kcLocal } };
}

// The launcher's own way in, for a gateway that will not mint the page a
// sign-in link (lib/localtoken.mjs): the gateway's local-owner bootstrap.
const kcLocal = { attempts: 0, lastOkAt: 0, lastError: null, lastCode: null };
let kcLocalInFlight = null;
let kcLocalEpochTried = -1;

/** One local sign-in at a time; concurrent callers share the running one. `keepPageError`: leave the page's own report (and its fix hint) as the tab's message when this fails. */
function kcLocalSignIn(via, keepPageError = false) {
  if (!kc || !kc.port || !gatewayUrl) return Promise.resolve({ ok: false, code: 'no_tunnel', error: 'the Kiro Crew tunnel is not running' });
  if (kcLocalInFlight) return kcLocalInFlight;
  kcLocalInFlight = (async () => {
    kcLocal.attempts++;
    const r = await signInWithLocalToken({
      env,
      homedir: os.homedir(),
      port: Number(gatewayUrl.port || 80),
      signIn: (token) => kcDoSignIn(token, via),
    });
    kcLocal.lastError = r.ok ? null : r.error || null;
    kcLocal.lastCode = r.ok ? null : r.code || null;
    if (r.ok) {
      kcLocal.lastOkAt = Date.now();
    } else if (!keepPageError) {
      kcSignIn.lastError = `local sign-in: ${r.error}`;
      kcSignIn.lastCode = r.code || null;
    }
    log('kc local sign-in via', via, r.ok ? 'ok' : `failed (${r.code}: ${r.error})`);
    return r;
  })().finally(() => {
    kcLocalInFlight = null;
  });
  return kcLocalInFlight;
}

/**
 * When the tab has no session and the user did not disconnect it, try the
 * local sign-in once per tunnel epoch (the epoch moves when a session ends),
 * so a refused or unreadable secret is not retried in a loop.
 */
function kcAutoLocalSignIn() {
  if (!kc || !kc.port) return;
  const s = kc.status();
  if (s.connected || s.userDisconnected || s.epoch === kcLocalEpochTried || kcLocalInFlight) return;
  kcLocalEpochTried = s.epoch;
  kcLocalSignIn('local').catch((e) => log('kc local sign-in crashed:', e && e.message));
}

/**
 * For the bridge only: the tunnel origin (a capability) and what the window's
 * Kiro Crew view frames for its page tab (lib/kctab.mjs embedPathFor): the
 * session the tab was opened from, or the session list. `tab` is null for a
 * window the page has no tab for (opened some other way).
 */
function kcBridgeBody(tab) {
  const body = kcBody();
  const embedPath = embedPathFor(tab && tab.session);
  const about = { tab: tab ? tab.id : null, session: tab ? tab.session : null, embedPath };
  if (viewer.via === 'origin') return overlayTabBody({ ...body, ...about });
  if (!kc || !kc.port) return { ...body, ...about };
  return { ...body, ...about, origin: kc.origin, embedUrl: `${kc.origin}${embedPath}` };
}

async function kcDoSignIn(link, via) {
  kcSignIn.attempts++;
  kcSignIn.lastAttempt = new Date().toISOString();
  kcSignIn.via = via;
  const r = await kc.signIn(link);
  kcSignIn.lastError = r.ok ? null : r.error;
  kcSignIn.lastCode = null;
  log('kc sign-in via', via, r.ok ? 'ok' : `failed (${r.error})`);
  return r;
}

/**
 * POST /_vscode-cli/mint-key on the frame port: the workbench's secret-storage
 * key, sha256(server half || the browser's HttpOnly client half). Only for the
 * frame's own origin and a request that carries the client half.
 */
function handleMint(req, res) {
  const clientHalf = clientHalfFrom(req.headers.cookie);
  const ok = mintAllowed({ method: req.method, host: req.headers.host, origin: req.headers.origin, listenPort: framePort, clientHalf, isLoopbackHost, isWebOrigin: isWebOriginHost(req.headers.host, APP_NAME) });
  req.resume();
  if (!ok.ok) {
    log('refused secret key mint', ok.error, `origin=${String(req.headers.origin || '').slice(0, 80)}`);
    return sendJson(res, ok.status, { error: ok.error });
  }
  const key = mintKey(secretHalf.key, clientHalf);
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(key.length), 'cache-control': 'no-store' });
  return res.end(key);
}

/**
 * The page's reachability probe: a tiny document that tells its parent which
 * launcher run answered. A page whose browser is on another machine (a remote
 * crew's dashboard) gets nothing from 127.0.0.1:<frame port> and so uses the
 * app web origin instead.
 */
function handleProbe(req, res) {
  req.resume();
  const body = `<!doctype html><meta charset="utf-8"><script>parent.postMessage({vscodePaneProbe:${JSON.stringify(RUN_ID)}},'*')</script>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

/**
 * Serves only the workbench under its key. On the frame listener the Host must
 * be loopback; on the main listener only the app web origin (<app>.apps.localhost,
 * relayed by the gateway) reaches this, and the same key path guards it.
 */
function handleFrame(req, res) {
  const webOrigin = isWebOriginHost(req.headers.host, APP_NAME);
  // A webview origin gets the webview host files and nothing else.
  if (isWebviewHost(req.headers.host) && !webviewRequestAllowed(req.method, req.url, BASE_PATH)) {
    req.resume();
    return sendJson(res, 403, { error: 'not available to webviews' });
  }
  const url = new URL(req.url, `http://${HOST}`);
  if (url.pathname === MINT_PATH) return handleMint(req, res);
  if (req.method === 'GET' && url.pathname === `${BASE_PATH}/`) viewer.via = webOrigin ? 'origin' : 'frame';
  if (url.pathname === PROBE_PATH && !webOrigin && req.method === 'GET' && isLoopbackHost(req.headers.host)) return handleProbe(req, res);
  const route = matchRoute(req.method, url.pathname, BASE_PATH);
  if (route.name !== 'frame') return sendJson(res, 404, { error: 'not found' });
  if (!webOrigin && !isLoopbackHost(req.headers.host)) return sendJson(res, 403, { error: 'bad host' });
  // The page loads each of its tabs with ?vscpTab=<id>; the workbench is told which tab it is.
  const paneTab = req.method === 'GET' && url.pathname === `${BASE_PATH}/` ? validTabId(url.searchParams.get('vscpTab')) : null;
  return frameProxy.handleRequest(req, res, webOrigin
    ? { webOrigin, paneTab, setCookies: [viewerCookieHeader(VIEWER_SECRET)], scriptSrc: `${BASE_PATH}/_vscp-kc.js` }
    : { webOrigin, paneTab });
}

/**
 * A request on the app's web origin: the workbench (and its two files for the
 * chat overlay) under the key path, the key mint route, and for every other path
 * the Kiro Crew chat, served only to a browser that holds the viewer cookie.
 */
function handleWebOrigin(req, res) {
  const url = new URL(req.url, `http://${HOST}`);
  const p = url.pathname;
  if (p === BASE_PATH || p.startsWith(BASE_PATH + '/') || p === MINT_PATH) {
    if (req.method === 'GET' && p === `${BASE_PATH}/_vscp-kc.js`) {
      const js = overlayScript(BASE_PATH);
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(js)) });
      return res.end(js);
    }
    if (req.method === 'GET' && p === WEB_PROBE_PATH) {
      // What the gateway relay's diagnosis (lib/weborigin.mjs) asks for: this run's id, nothing else.
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(RUN_ID);
    }
    if (req.method === 'GET' && p === `${BASE_PATH}/_vscp-kc/state`) {
      handleKcState(req, res, url).catch((e) => {
        log('kc state error', e.message);
        sendJson(res, 500, { error: 'internal error' });
      });
      return undefined;
    }
    return handleFrame(req, res);
  }
  if (!kc || !kc.port || !viewerOk(req.headers.cookie, VIEWER_SECRET)) {
    req.resume();
    return sendJson(res, 404, { error: 'not found' });
  }
  return kc.serveShared(req, res);
}

/** The chat overlay's poll: whether the tab is signed in, and what the page tab's Kiro Crew view shows (nothing is created). */
async function handleKcState(req, res, url) {
  if (!viewerOk(req.headers.cookie, VIEWER_SECRET)) return sendJson(res, 403, { error: 'no viewer' });
  const id = validTabId(url.searchParams.get('tab'));
  const tab = id ? tabs.get(id) : null;
  const st = kc && kc.port ? kc.status() : null;
  return sendJson(res, 200, { connected: !!(st && st.connected), tab: tab ? tab.id : null, embed: embedPathFor(tab && tab.session) });
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
  // The VS Code window a bridge call comes from (one extension host each).
  const bridgeHost = route.auth === 'bridge' ? String(req.headers['x-kiro-bridge-host'] || '').slice(0, 64) || null : null;
  if (bridgeHost) bridge.seeHost(bridgeHost);

  switch (route.name) {
    case 'health':
      return sendJson(res, 200, { ok: true, status: state.status });
    case 'session':
      return sendJson(res, 200, sessionBody(url.searchParams.get('folder')));
    case 'tabsOpen': {
      // Open a tab (or bring back the one already open): from the composer's
      // VS Code chip with the chat's session and folder, from the page's New tab,
      // or from a `?folder=` link. A session tab is reused wherever its folder is now.
      const parsed = parseJson(body);
      if (!parsed || typeof parsed !== 'object') return sendJson(res, 400, { error: 'body must be {folder?, session?, reuse?}' });
      const hasSession = parsed.session !== undefined && parsed.session !== null && parsed.session !== '';
      const session = hasSession ? validSessionKey(parsed.session) : null;
      if (hasSession && !session) return sendJson(res, 400, { error: 'session must be a Kiro Crew session key' });
      const hasFolder = parsed.folder !== undefined && parsed.folder !== null && parsed.folder !== '';
      const asked = hasFolder ? validFolder(parsed.folder) : null;
      if (hasFolder && !asked) return sendJson(res, 400, { error: 'folder must be an absolute path' });
      const open = session ? tabs.bySession(session) : null;
      if (open) {
        tabs.activate(open.id);
        return sendJson(res, 200, { tab: tabs.get(open.id), created: false, tabs: tabsBody() });
      }
      let folder = asked || defaultFolder();
      let note = null;
      // A chat whose project folder is gone still gets its tab, on the default folder.
      if (session && asked && !isDirectory(asked)) {
        note = `${asked} is not a folder on this machine any more, so this chat's tab opened on ${defaultFolder()}`;
        folder = defaultFolder();
      }
      if (!isDirectory(folder)) return sendJson(res, 400, { error: `${folder} is not a folder on this machine` });
      const r = tabs.open({ folder, session, reuse: parsed.reuse === true });
      if (r.error) return sendJson(res, r.status || 409, { error: r.error });
      if (r.created) log('tab opened', r.tab.id, session ? `for session ${session}` : 'on its own');
      return sendJson(res, 200, { tab: r.tab, created: r.created, tabs: tabsBody(), ...(note ? { note } : {}) });
    }
    case 'tabsActivate':
    case 'tabsClose': {
      const parsed = parseJson(body);
      const id = validTabId(parsed && parsed.id);
      if (!id) return sendJson(res, 400, { error: 'body must be {id}, a tab id' });
      const done = route.name === 'tabsClose' ? tabs.close(id) : tabs.activate(id);
      if (!done) return sendJson(res, 404, { error: 'no such tab', tabs: tabsBody() });
      if (route.name === 'tabsClose') log('tab closed', id);
      return sendJson(res, 200, { ok: true, tabs: tabsBody() });
    }
    case 'state':
      return sendJson(res, 200, { ...bridge.snapshot(validTabId(url.searchParams.get('tab'))), serverStatus: state.status });
    case 'open': {
      const raw = parseJson(body);
      const parsed = parseOpenRequest(raw);
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      if (parsed.command.kind === 'openFolder') {
        // A folder opens as a tab of its own (or the tab already on it), not in place of another tab's folder.
        const folder = validFolder(parsed.command.path);
        if (!folder || !isDirectory(folder)) return sendJson(res, 400, { error: 'path must be a folder on this machine' });
        const r = tabs.open({ folder, reuse: true });
        if (r.error) return sendJson(res, r.status || 409, { error: r.error });
        return sendJson(res, 200, { ok: true, command: parsed.command, tab: r.tab, created: r.created });
      }
      // A file goes to the tab named in the body, else the tab whose folder holds it, else the front tab.
      const named = validTabId(raw && raw.tab) ? tabs.get(raw.tab) : null;
      const pick = tabForFile(parsed.command.path, { named });
      if (pick.error) return sendJson(res, pick.status || 409, { error: pick.error });
      const target = pick.tab;
      if (target && target.id !== tabs.active) tabs.activate(target.id);
      const { id, done } = bridge.enqueue(parsed.command, 8000, tabRoute(target));
      const result = await done;
      return sendJson(res, 200, { id, command: parsed.command, tab: target ? target.id : null, ...result, bridgeConnected: bridge.connected });
    }
    case 'restart':
      restartServer();
      return sendJson(res, 202, { ok: true, status: 'restarting' });
    case 'webOrigin': {
      // Whether the gateway relays this app on the port the page's browser reaches
      // the dashboard on, and if not, the one line that would let it.
      const port = validPort(url.searchParams.get('port'));
      if (!port) return sendJson(res, 400, { error: 'port must be a TCP port' });
      const home = dataHome(env, os.homedir());
      let envText = '';
      try {
        envText = fs.readFileSync(path.join(home, '.env'), 'utf8');
      } catch {
        envText = '';
      }
      const base = { envFile: path.join(home, '.env'), variable: PORTS_VAR, listed: listedPorts(envText), gatewayPort: gatewayUrl ? Number(gatewayUrl.port || 80) : null };
      if (!gatewayUrl) return sendJson(res, 200, { ...base, state: 'gateway_unreachable', port, detail: 'no gateway address (KIROCREW_GATEWAY_ORIGIN)' });
      const d = await diagnose({ gatewayPort: base.gatewayPort, appName: APP_NAME, port, probePath: WEB_PROBE_PATH, instance: RUN_ID });
      return sendJson(res, 200, { ...base, ...d });
    }
    case 'webOriginAllow': {
      // The page's "Allow port" button: add the port to KIROCREW_ALLOWED_LOOPBACK_PORTS
      // in Kiro Crew's .env. The gateway reads it at start, so it needs a restart.
      const parsed = parseJson(body);
      const port = validPort(parsed && parsed.port);
      if (!port) return sendJson(res, 400, { error: 'body must be {port: a TCP port}' });
      const r = addAllowedPort({ home: dataHome(env, os.homedir()), port });
      log('allow loopback port', port, r.ok ? (r.changed ? 'added' : 'already listed') : r.error);
      return sendJson(res, r.ok ? 200 : 500, { ...r, variable: PORTS_VAR, restartNeeded: !!r.ok });
    }
    case 'serverUpdateCheck': {
      if (!serverOwned()) return sendJson(res, 409, { error: 'this VS Code server was not installed by Kiro Crew, so it is not updated from here' });
      if (state.installing || (state.update && state.update.phase === 'restarting')) return sendJson(res, 200, state.update);
      return sendJson(res, 200, await checkServerUpdate());
    }
    case 'serverUpdateInstall': {
      // Only the build the last check named can be installed: the user saw it and chose it.
      const parsed = parseJson(body);
      const commit = parsed && typeof parsed.commit === 'string' ? parsed.commit.toLowerCase() : '';
      if (!COMMIT_RE.test(commit)) return sendJson(res, 400, { error: 'body must be {commit}, the build the update check named' });
      if (!serverOwned()) return sendJson(res, 409, { error: 'this VS Code server was not installed by Kiro Crew, so it is not updated from here' });
      if (state.installing || launching) return sendJson(res, 409, { error: 'an update is already running' });
      const named = state.update && state.update.phase === 'available' && state.update.latest ? state.update.latest.commit : '';
      if (named !== commit) return sendJson(res, 409, { error: 'check for updates first: the build asked for is not the one the last check named' });
      installServerUpdate(commit).catch((e) => log('server update', e.message));
      return sendJson(res, 202, { ok: true, status: 'downloading' });
    }
    case 'installServer':
      if (!state.needsInstall || !config.allowDownload) return sendJson(res, 409, { error: 'no VS Code server download is needed or allowed' });
      if (state.installing) return sendJson(res, 202, { ok: true, status: 'downloading' });
      installLatestServer();
      return sendJson(res, 202, { ok: true, status: 'downloading' });
    case 'fileMenu': {
      // "Open in VS Code" from Kiro Crew's file menus: a folder opens as a tab of
      // its own (or the tab already on it); a file opens in the tab whose folder
      // holds it, else a tab on the project root the menu names, else the front tab.
      const raw = parseJson(body);
      const parsed = fileMenuToCommand(raw);
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      const origin = env.KIROCREW_GATEWAY_ORIGIN;
      const name = path.basename(parsed.command.path);
      let target = null;
      if (parsed.command.kind === 'openFolder') {
        const folder = validFolder(parsed.command.path);
        if (!folder || !isDirectory(folder)) return sendJson(res, 400, { error: 'path must be a folder on this machine' });
        const r = tabs.open({ folder, reuse: true });
        if (r.error) return sendJson(res, r.status || 409, { error: r.error });
        target = tabs.get(r.tab.id);
      } else {
        const pick = tabForFile(parsed.command.path, { root: raw && raw.root });
        if (pick.error) return sendJson(res, pick.status || 409, { error: pick.error });
        target = pick.tab;
        if (target && target.id !== tabs.active) tabs.activate(target.id);
        bridge.enqueue(parsed.command, 8000, tabRoute(target));
      }
      const page = `${String(origin || '').replace(/\/$/, '')}/apps/vscode-pane${target ? `?tab=${target.id}` : ''}`;
      return sendJson(res, 200, {
        message: parsed.command.kind === 'openFolder'
          ? `Opening ${name} in a VS Code tab`
          : bridge.connected
            ? `Opening ${name} in VS Code`
            : `Queued ${name} for VS Code; open the VS Code app page to see it`,
        ...(origin ? { url: page } : {}),
      });
    }
    case 'bridgeCommands': {
      // Each window (extension host) takes its own commands (lib/bridge.mjs routes).
      const rawWait = url.searchParams.get('wait');
      const askedWait = rawWait === null || rawWait === '' ? 25 : Number(rawWait);
      const wait = (Number.isFinite(askedWait) ? Math.min(Math.max(askedWait, 0), 25) : 25) * 1000;
      const ac = new AbortController();
      res.on('close', () => ac.abort());
      const host = String(url.searchParams.get('host') || bridgeHost || '').slice(0, 64) || null;
      const batch = await bridge.take(wait, ac.signal, host);
      if (res.destroyed || res.writableEnded) {
        bridge.requeue(batch);
        return;
      }
      return sendJson(res, 200, { commands: batch });
    }
    case 'bridgeEvents': {
      const ev = parseJson(body);
      const sender = ev && typeof ev.host === 'string' && ev.host ? ev.host.slice(0, 64) : bridgeHost;
      // A new extension host (first start, a reload, a new tab, a server
      // restart) gets the current theme once; it writes it only if it differs.
      const known = sender ? bridge.hosts.get(sender) : null;
      const firstHello = !!(ev && ev.type === 'hello' && (!sender || !known || !known.helloAt));
      // A window can only claim a tab the page has open.
      if (ev && (ev.type === 'tab' || ev.type === 'hello') && ev.tab !== undefined && !(validTabId(ev.tab) && tabs.get(ev.tab))) ev.tab = null;
      if (!bridge.applyEvent(ev, bridgeHost)) return sendJson(res, 400, { error: 'unknown event' });
      if (firstHello && vsTheme) bridge.enqueueLatest(themeCommand(), 8000, sender ? { host: sender } : null);
      if (ev.type === 'chatPrefs') applyChatPrefs({ hideCopilotAgents: ev.hideCopilotAgents }, 'vscode');
      if (sender && (ev.type === 'tab' || ev.type === 'hello')) followWindowFolder(sender);
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
        // Every window: each browser origin keeps its own copy of the user settings.
        bridge.broadcast(themeCommand());
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
      // The front tab's window (or the tab named in the body).
      const target = (validTabId(parsed.tab) && tabs.get(parsed.tab)) || tabs.get(tabs.active);
      const { id, done } = bridge.enqueue({ kind: 'askChat', prompt, ...(parsed.newChat === true ? { newChat: true } : {}) }, 8000, tabRoute(target));
      const result = await done;
      return sendJson(res, 200, { id, ...result, bridgeConnected: bridge.connected });
    }
    case 'kcSignIn': {
      // The page traded the dashboard's own session for a sign-in link
      // (POST /api/auth/mobile-link with the dashboard's cookie) and hands it
      // over, or reports why it could not.
      if (!kc || !kc.port) return sendJson(res, 503, { error: 'the Kiro Crew tunnel is not running' });
      const parsed = parseJson(body);
      if (parsed && typeof parsed.error === 'string' && !parsed.url) {
        const via = parsed.via === 'connect' ? 'connect' : 'auto';
        // A local sign-in just worked (the launcher's own, or the one this
        // report is about to start): the page's refusal is not news.
        const justSignedIn = kc.status().connected && Date.now() - kcLocal.lastOkAt < 10_000;
        if (!justSignedIn) {
          kcSignIn.attempts++;
          kcSignIn.lastAttempt = new Date().toISOString();
          kcSignIn.via = via;
          kcSignIn.lastError = parsed.error.slice(0, 400);
          kcSignIn.lastCode = typeof parsed.code === 'string' && /^[A-Za-z0-9_ -]{1,60}$/.test(parsed.code) ? parsed.code : null;
          log('kc sign-in from the page failed:', kcSignIn.lastError);
          // The page could not mint a link (a gateway can refuse it, or have no
          // dashboard URL): the launcher signs in with the gateway's local token.
          // A Connect press goes ahead of a Disconnect and of a live session
          // (which may be dead), an automatic attempt does not.
          const s = kc.status();
          if (via === 'connect' || (!s.connected && !s.userDisconnected)) await kcLocalSignIn(via === 'connect' ? 'connect' : 'local', true);
        }
        return sendJson(res, 200, { ok: false, kc: kcBody() });
      }
      if (!parsed || typeof parsed.url !== 'string') return sendJson(res, 400, { error: 'body must be {url} or {error}' });
      // Disconnect sticks until the user presses Connect or pastes a link.
      if (parsed.via !== 'connect' && parsed.via !== 'paste' && kc.status().userDisconnected) {
        return sendJson(res, 409, { ok: false, error: 'the tab was disconnected; press Connect to sign it in again', code: 'user_disconnected', kc: kcBody() });
      }
      const r = await kcDoSignIn(parsed.url, parsed.via === 'connect' ? 'connect' : parsed.via === 'paste' ? 'paste' : 'auto');
      return sendJson(res, r.ok ? 200 : r.status === 400 ? 400 : 200, { ok: r.ok, error: r.error || null, kc: kcBody() });
    }
    case 'kcDisconnect': {
      if (!kc) return sendJson(res, 503, { error: 'the Kiro Crew tunnel is not running' });
      await kc.disconnect();
      return sendJson(res, 200, { ok: true, kc: kcBody() });
    }
    case 'bridgeKc': {
      // What this window's Kiro Crew view shows: its page tab's session, or the
      // session list. The tab is the one the page told the view it is in.
      const id = validTabId(url.searchParams.get('tab'));
      const tab = id ? tabs.get(id) : null;
      return sendJson(res, 200, kcBridgeBody(tab));
    }
    case 'bridgeKcSignIn': {
      if (!kc || !kc.port) return sendJson(res, 503, { error: 'the Kiro Crew tunnel is not running' });
      const parsed = parseJson(body);
      if (!parsed || typeof parsed.url !== 'string') return sendJson(res, 400, { error: 'body must be {url}' });
      const r = await kcDoSignIn(parsed.url, 'paste');
      return sendJson(res, r.status === 400 ? 400 : 200, { ok: r.ok, error: r.error || null, kc: kcBody() });
    }
    case 'bridgeKcConnect': {
      // The tab's Connect button. The page (inside the signed-in dashboard)
      // sees the request on its next session poll and mints a link; the
      // launcher also tries the gateway's local token now, so Connect works
      // when the gateway will not mint that link or the page is not open.
      kcSignIn.connectRequests++;
      let local = null;
      if (kc && kc.port) local = await kcLocalSignIn('connect');
      return sendJson(res, 200, { ok: true, connectRequests: kcSignIn.connectRequests, signedIn: !!(local && local.ok) });
    }
    case 'bridgeKcDisconnect':
      if (!kc) return sendJson(res, 503, { error: 'the Kiro Crew tunnel is not running' });
      await kc.disconnect();
      return sendJson(res, 200, { ok: true, kc: kcBody() });
    case 'crewView': {
      // Reveal VS Code's "Kiro Crew" view, or move it to another part, in the
      // front tab's window (or the tab named in the body).
      const raw = parseJson(body);
      const parsed = parseCrewViewRequest(raw);
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      const target = (raw && validTabId(raw.tab) && tabs.get(raw.tab)) || tabs.get(tabs.active);
      const { id, done } = bridge.enqueue(parsed.command, 8000, tabRoute(target));
      return sendJson(res, 200, { id, ...(await done), bridgeConnected: bridge.connected });
    }
    case 'secretProbe': {
      // Stores or reads one fixed probe value in the bridge's own
      // context.secrets, so a check can prove secrets persist. Nothing else
      // in secret storage is reachable here.
      const parsed = parseSecretProbe(parseJson(body));
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      const { id, done } = bridge.enqueue(parsed.command, 8000);
      const r = await done;
      return sendJson(res, 200, { id, ok: !!r.ok, value: typeof r.value === 'string' ? r.value : null, error: r.error || null, bridgeConnected: bridge.connected });
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
      // Opens a Kiro Crew chat session in VS Code's Chat (by its slot), in the
      // window of the tab on the session's folder (the front tab first).
      const parsed = parseJson(body);
      const s = sessionFor(parsed && parsed.slot, bridgeHost);
      if (!s) return sendJson(res, 404, { error: 'unknown session' });
      const front = tabs.get(tabs.active);
      const target = front && folderInRoots(s.folder, [front.folder]) ? front : tabHolding(s.folder) || front;
      const { id, done } = bridge.enqueue({ kind: 'openChatSession', slot: s.slot }, 12000, tabRoute(target));
      return sendJson(res, 200, { id, ...(await done), bridgeConnected: bridge.connected });
    }
    case 'bridgeSessions': {
      const roots = windowRoots(bridgeHost);
      return sendJson(res, 200, { sessions: sessions.list((f) => folderInRoots(f, roots)) });
    }
    case 'bridgeSessionCreate': {
      const parsed = parseJson(body);
      const folder = parsed && typeof parsed.folder === 'string' ? parsed.folder : '';
      if (!folder || !path.isAbsolute(folder) || !folderInRoots(folder, windowRoots(bridgeHost))) return sendJson(res, 403, { error: 'folder is not open in this VS Code window' });
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
      const s = sessionFor(url.searchParams.get('slot'), bridgeHost);
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
      const s = sessionFor(parsed && parsed.slot, bridgeHost);
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
      const s = sessionFor(parsed && parsed.slot, bridgeHost);
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
      if (raw && raw.slot !== undefined) return nativeChat(raw, res, bridgeHost);
      const parsed = parseChatRequest(raw, {
        defaultFolder: bridge.rootsFor(bridgeHost)?.[0] || (fs.existsSync(config.workspace) ? config.workspace : null),
      });
      if (parsed.error) return sendJson(res, 400, { error: parsed.error });
      // A chat turn runs Kiro Crew with tools in the folder, so only a folder
      // this VS Code window has open (or the default workspace when none is).
      const roots = windowRoots(bridgeHost);
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
  // The gateway's web origin relay lands here with Host <app>.apps.localhost.
  // Such a request reaches the workbench only: never the signed or bridge API.
  if (isWebOriginHost(req.headers.host, APP_NAME)) {
    try {
      handleWebOrigin(req, res);
    } catch (e) {
      log('web origin handler error', e.stack || e.message);
      sendJson(res, 500, { error: 'internal error' });
    }
    return;
  }
  handle(req, res).catch((e) => {
    log('handler error', e.stack || e.message);
    sendJson(res, 500, { error: 'internal error' });
  });
});
// The API port upgrades only for the app web origin's workbench socket; the
// same socket on the frame port is handled below.
server.on('upgrade', (req, socket, head) => {
  const p = (req.url || '').split('?')[0];
  if (!isWebOriginHost(req.headers.host, APP_NAME)) return socket.destroy();
  if (p !== BASE_PATH && !p.startsWith(BASE_PATH + '/')) {
    // The Kiro Crew chat's WebSocket, on the web origin.
    if (!kc || !kc.port || !viewerOk(req.headers.cookie, VIEWER_SECRET)) return socket.destroy();
    return kc.upgradeShared(req, socket, head);
  }
  if (!upgradeAllowed({ host: req.headers.host, origin: req.headers.origin, listenPort: listenPort, appName: APP_NAME })) {
    log('refused WebSocket upgrade (web origin)', `host=${String(req.headers.host).slice(0, 80)}`, `origin=${String(req.headers.origin).slice(0, 80)}`);
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  return frameProxy.handleUpgrade(req, socket, head);
});

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
  if (isWebviewHost(req.headers.host) || !upgradeAllowed({ host: req.headers.host, origin: req.headers.origin, listenPort: framePort })) {
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
  if (kc) kc.close();
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
  if (kc) {
    try {
      await kc.listen();
      log('kc tunnel listening on 127.0.0.1:' + kc.port, 'upstream', gatewayUrl.host);
      kcAutoLocalSignIn();
    } catch (e) {
      log('kc tunnel could not listen:', e.message);
    }
  }
  log('secret storage key half', secretHalf.created ? `created${secretHalf.restricted ? ' (owner-only)' : ' (could not restrict access)'}` : 'loaded');
  log('launcher listening', `${HOST}:${listenPort}`, 'frame', `${HOST}:${framePort}`, framePort === frameState.port ? '(saved port)' : '(new port)', 'data', DATA_DIR, 'signed', PROXY_SECRET ? 'yes' : 'no');
  console.log(JSON.stringify({ event: 'listening', port: listenPort, framePort, pid: process.pid }));
  launchServer();
  // One early gateway call, so an Update whose new chat permissions are not
  // approved yet shows in the page before anyone tries chat.
  if (!gateway.unavailableReason) {
    gateway.status().catch((e) => log('gateway probe at start:', e.message));
  }
});
