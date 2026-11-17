#!/usr/bin/env node
// End-to-end smoke test for the vscode-pane launcher, run standalone (no
// Kiro Crew gateway). It plays the gateway's part: sets PORT and
// KIROCREW_PROXY_SECRET, signs /api calls like the proxy, and stops the
// backend with a Windows tree kill like the gateway does.
//
//   node scripts/smoke.mjs [--keep] [--server-dir <path>] [--minimal-env] [--native-only]
//
// --native-only stops after the Kiro Crew chat session type checks (step 6n).
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
import { manifestIconFiles, svgProblems, isPng } from './lib/icon-checks.mjs';
import { extensionIconChecks } from './lib/ext-icon-checks.mjs';
import { createDashboardStandin } from './lib/dashboard-standin.mjs';
import { tabChecks, tunnelPersists } from './lib/tab-checks.mjs';
import { startLoadWatch, loadChecks } from './lib/load-checks.mjs';
import { secretChecks, secretReadBack } from './lib/secret-checks.mjs';
import { createGatewayMock } from '../test/support/gateway-mock.mjs';
import { toVsCodeTheme } from '../backend/lib/theme.mjs';
import { slotNameFor } from '../backend/lib/gateway.mjs';
import { nativeChatChecks, copilotAgentChecks, historyChecks, isSessionSlot, sessionTargetChecks } from './lib/nativechat-smoke.mjs';

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
const NATIVE_ONLY = argv.includes('--native-only');
class StopEarly extends Error {}
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
const DEPS_ROOT = DEV.smokeDepsRoot && fs.existsSync(DEV.smokeDepsRoot) ? DEV.smokeDepsRoot : ROOT;

function findCachedServer() {
  if (DEV.serverDir && fs.existsSync(path.join(DEV.serverDir, 'out', 'server-main.js'))) return DEV.serverDir;
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
  // Windows keeps a dead parent's PID in ParentProcessId, and that PID can be
  // reused by a process in our tree; a real child is never older than its parent.
  const createdMs = (p) => { const m = /Date\((\d+)/.exec(p.created); return m ? Number(m[1]) : Date.parse(p.created) || 0; };
  const queue = root ? [root] : [];
  while (queue.length) {
    const parent = queue.shift();
    for (const p of table) {
      if (p.ppid === parent.pid && !out.includes(p) && createdMs(p) >= createdMs(parent)) {
        out.push(p);
        queue.push(p);
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

  // Item 1: the card matches the Sessions panel card and the frame is clipped to
  // it, with the nav as the collapsed icon rail and as the expanded sidebar
  // (the same <nav> classes in a 74px or 236px track; navRail.tsx:457,
  // useRailWidth.ts:20-21).
  const measure = () => page.evaluate(() => {
    const el = document.querySelector('[data-testid="vscode-pane-card"]');
    const host = document.querySelector('div[data-vscode-pane-frame-host]');
    const main = document.getElementById('main-content');
    const rail = document.getElementById('rail');
    const shell = document.getElementById('shell');
    const bar = document.querySelector('[role="toolbar"]');
    const hair = document.getElementById('rail-hairline');
    if (!el || !host || !bar) return null;
    const cs = getComputedStyle(el);
    const ms = getComputedStyle(main);
    const rs = getComputedStyle(rail);
    const r = el.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const mr = main.getBoundingClientRect();
    const rl = rail.getBoundingClientRect();
    const sl = shell.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    const hl = hair.getBoundingClientRect();
    const r1 = (n) => Math.round(n * 10) / 10;
    return {
      railWidth: r1(rl.width + 16),
      radius: cs.borderTopLeftRadius, border: cs.borderTopWidth, railRadius: rs.borderTopLeftRadius, railBorder: rs.borderTopWidth,
      bg: cs.backgroundColor,
      inset: [r.left - mr.left, r.top - mr.top, mr.right - r.right, mr.bottom - r.bottom].map((n) => Math.round(n)),
      mainPadding: [ms.paddingTop, ms.paddingRight, ms.paddingBottom, ms.paddingLeft].join(' '),
      railGap: r1(r.left - rl.right),
      railTop: r1(r.top - rl.top),
      railBottom: r1(r.bottom - rl.bottom),
      // The rail's own left inset, so the card's right inset can be compared with it.
      railLeft: r1(rl.left - sl.left),
      railShape: [Math.round(rl.top - mr.top), Math.round(mr.left - rl.right), rs.marginBottom].join(' '),
      clip: host.style.clipPath,
      // Frame edges against the card's inner edges and the toolbar's bottom: 0 = no seam, no overlap.
      seams: [hr.top - br.bottom, hr.left - (r.left + 1), (r.right - 1) - hr.right, (r.bottom - 1) - hr.bottom].map(r1),
      bar: r1(br.height),
      barTop: r1(br.top - r.top),
      // The toolbar's bottom border (its last 1px) and its content centre, from the card's outer top.
      barLine: r1(br.bottom - 1 - r.top),
      barCentre: r1(br.top + (br.height - 1) / 2 - r.top),
      // The expanded sidebar's header hairline, from the rail's outer top (null when hidden).
      hairline: hl.height ? r1(hl.top - rl.top) : null,
    };
  });
  for (const mode of ['collapsed', 'expanded']) {
    await page.evaluate((m) => window.__standin.setNav(m), mode);
    await sleep(400);
    const card = await measure();
    const tag = `[${mode} nav]`;
    // The stand-in reproduces App.tsx: <main> unpadded, the rail card's top level
    // with <main>'s top, 8px from <main> on the right and 8px up from the bottom.
    check(`${tag} stand-in reproduces the dashboard shell (${mode === 'expanded' ? '236' : '74'}px track; unpadded <main>; rail card top at <main> top, 8px right and bottom margins; header hairline ${mode === 'expanded' ? 'at 45px' : 'hidden'})`,
      card && card.mainPadding === '0px 0px 0px 0px' && card.railShape === '0 8 8px' && card.railWidth === (mode === 'expanded' ? 236 : 74) &&
        card.hairline === (mode === 'expanded' ? 45 : null),
      card && `${card.mainPadding}; rail ${card.railShape}, track ${card.railWidth}, hairline ${card.hairline}`);
    // The Sessions card: no margin of its own, drawer pb-2 (listShell.ts, OverlayDrawer.tsx).
    check(`${tag} pane card sits where the Sessions card does: 8px from the rail card, top and bottom level with it, flush left and top in <main>, 8px right and bottom (= the rail's 8px left inset)`,
      card && card.railGap === 8 && card.railTop === 0 && card.railBottom === 0 && JSON.stringify(card.inset) === '[0,0,8,8]' && card.railLeft === 8,
      card && `gap ${card.railGap}, top ${card.railTop}, bottom ${card.railBottom}, inset ${JSON.stringify(card.inset)}, rail left ${card.railLeft}`);
    check(`${tag} pane card has the rail and Sessions panel radius and border (16px, 1px)`,
      card && card.radius === '16px' && card.border === '1px' && card.radius === card.railRadius && card.border === card.railBorder,
      JSON.stringify(card && { radius: card.radius, border: card.border, rail: [card.railRadius, card.railBorder] }));
    check(`${tag} frame fills the card below the toolbar with no seam or overlap, clipped to the 15px inner radius`,
      card && card.seams.every((n) => Math.abs(n) <= 0.5) && /round 0px 0px 15px 15px/.test(card.clip), card && `${JSON.stringify(card.seams)}; ${card.clip}`);
    check(`${tag} toolbar: 45px strip under the card's top border, centre on the 23px header line, bottom border at 45px${mode === 'expanded' ? ' level with the sidebar hairline' : ''}`,
      card && card.bar === 45 && card.barTop === 1 && card.barCentre === 23 && card.barLine === 45 && (mode !== 'expanded' || card.barLine === card.hairline),
      card && `bar ${card.bar}, top ${card.barTop}, centre ${card.barCentre}, line ${card.barLine}, hairline ${card.hairline}`);
  }
  await page.evaluate(() => window.__standin.setNav('collapsed'));
  await sleep(300);

  // The frame is placed on change, not every animation frame, and still
  // follows the card through a window resize and a layout shift.
  const placements0 = await page.evaluate(() => window.__vscodePane.placements);
  await sleep(3000);
  const placements1 = await page.evaluate(() => window.__vscodePane.placements);
  check('idle for 3 s the frame is placed at most ~3 times a second (not every animation frame)', placements1 - placements0 <= 10, `${placements1 - placements0} placements in 3 s`);
  const tracks = () => page.evaluate(() => {
    const host = document.querySelector('div[data-vscode-pane-frame-host]').getBoundingClientRect();
    const slot = document.querySelector('[data-testid="vscode-pane-frame-slot"]').getBoundingClientRect();
    const d = [host.left - slot.left, host.top - slot.top, host.width - slot.width, host.height - slot.height].map((n) => Math.round(n * 10) / 10);
    return { ok: d.every((n) => Math.abs(n) <= 1), d, slot: [slot.left, slot.top, slot.width, slot.height].map(Math.round) };
  });
  await page.setViewportSize({ width: 1100, height: 700 });
  await sleep(400);
  const afterResize = await tracks();
  check('after a window resize the frame matches the card slot', afterResize.ok, JSON.stringify(afterResize));
  await page.evaluate(() => { document.getElementById('shell').style.gridTemplateColumns = '200px 1fr'; });
  await sleep(400);
  const afterShift = await tracks();
  check('after a layout shift (wider side rail) the frame matches the card slot', afterShift.ok && afterShift.slot[0] !== afterResize.slot[0], JSON.stringify(afterShift));
  await page.evaluate(() => { document.getElementById('shell').style.gridTemplateColumns = ''; });
  await page.setViewportSize({ width: 1400, height: 900 });
  await sleep(400);
  const restored = await tracks();
  check('back at the first size the frame matches the card slot again', restored.ok, JSON.stringify(restored));

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

  // Fallback: a palette whose tokens cannot be read sends {kind} alone, and the
  // card falls back to stock VS Code Default Light / Dark colours by that kind.
  const cardBgNow = () => page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="vscode-pane-card"]')).backgroundColor);
  const kindOnly = (k) => (b) => b.kind === k && !('vars' in b) && Object.keys(b).length === 1;
  let since = hostServer.themePosts.length;
  await page.evaluate(() => window.__standin.setTheme('plain-light'));
  const bareLight = await waitTheme(kindOnly('light'), since);
  check('unreadable palette named *-light POSTs {kind: "light"} with no vars', !!bareLight, JSON.stringify(hostServer.themePosts.slice(-1).map((p) => p.body)));
  const bgLight = await cardBgNow();
  check('toolbar and card fall back to Default Light colours', bgLight === 'rgb(248, 248, 248)', bgLight);
  await page.emulateMedia({ colorScheme: 'dark' });
  since = hostServer.themePosts.length;
  await page.evaluate(() => window.__standin.setTheme('plain'));
  const bareDark = await waitTheme(kindOnly('dark'), since);
  check('unreadable palette with no light/dark name POSTs {kind} from the OS scheme (dark)', !!bareDark, JSON.stringify(hostServer.themePosts.slice(-1).map((p) => p.body)));
  const bgDark = await cardBgNow();
  check('toolbar and card fall back to Default Dark colours', bgDark === 'rgb(24, 24, 24)', bgDark);
  await page.emulateMedia({ colorScheme: null });
  since = hostServer.themePosts.length;
  await page.evaluate(() => window.__standin.setTheme('dracula-dark'));
  check('the readable palette comes back with vars', !!(await waitTheme((b) => b.kind === 'dark' && b.vars && b.vars['--bg'] === '#21222c', since)));

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
  await page.locator('[data-testid="composer-context-shelf"] [data-chip-id^="vscode-pane:"]').click({ timeout: 5000 });
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
  // A folder name with a space (V3 N-5, V4 N-5): slot names, folder checks,
  // terminal paths and the Kiro Crew tab all have to cope with it.
  const workspace = path.join(runDir, 'my workspace');
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
  // The stand-in dashboard's ports, chosen now so every launcher start can name
  // them as frame ancestors of the Kiro Crew tunnel (VSCODE_PANE_DASHBOARD_ORIGIN).
  const hostPort = await freePort();
  const hostPort2 = await freePort();
  console.log(`run dir ${runDir}\nserver build ${serverDir}\nlauncher port ${PORT}${MINIMAL_ENV ? '\nlauncher env: gateway minimal_env allowlist only' : ''}`);

  // A mock Kiro Crew gateway for the chat round trip; the launcher trades the
  // proxy secret for an app token there, as it would against the real one.
  // No unanswerable legacy permission row in the default reply: the native
  // checks below drive approvals with the mock's "approve me" turn.
  const gatewayMock = createGatewayMock({ appName: 'vscode-pane', secret: SECRET, defaultPermission: false });
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
        // Never the real Kiro Crew home: the launcher's local sign-in reads gateway secrets from it.
        KIROCREW_HOME: path.join(dataDir, 'no-kiro-crew-home'),
        VSCODE_PANE_DATA_DIR: dataDir,
        VSCODE_PANE_WORKSPACE: workspace,
        ...(APP ? {} : { VSCODE_PANE_SERVER_DIR: serverDir }),
        VSCODE_PANE_NO_DOWNLOAD: '1',
        VSCODE_PANE_DASHBOARD_ORIGIN: `http://localhost:${hostPort},http://localhost:${hostPort2}`,
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
  let browserCdn = [];
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
    const pathKey = (/^\/vsc-([^/]+)\//.exec(wbUrl.pathname) || [])[1] || '';
    check(
      'frame.json keeps only the frame port; the path key is not written to disk',
      JSON.stringify(Object.keys(savedFrame)) === '["port"]' && savedFrame.port === framePort && pathKey.length >= 24 && !fs.readFileSync(path.join(dataDir, 'state', 'frame.json'), 'utf8').includes(pathKey),
      JSON.stringify(Object.keys(savedFrame)),
    );
    check('/api/session carries a run id', typeof session.instance === 'string' && session.instance.length >= 8, String(session.instance));
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
    check('new chats default to the Kiro Crew model by setting (chat.defaultModel)', machine['chat.defaultModel'] === 'kiro-crew', String(machine['chat.defaultModel']));
    const serverArgsLog = fs.readFileSync(path.join(dataDir, 'logs', 'launcher.log'), 'utf8');
    check('launcher log names the frame port', /frame 127\.0\.0\.1:\d+/.test(serverArgsLog));

    // 4. workbench HTML
    const wb = await rawRequest({ port: framePort, path: wbUrl.pathname + wbUrl.search, headers: { cookie: 'mc_token_5476=dashboard-secret' } });
    const csp = String(wb.headers['content-security-policy'] || '');
    check('workbench GET returns 200', wb.status === 200, `${wb.status}, ${wb.body.length} bytes`);
    {
      const first = wb.body.indexOf('<style id="vscp-boot">');
      const seededBg = String(seeded.colorCustomizations['editor.background']).slice(0, 7);
      check('the workbench page carries the Kiro Crew first-paint rule first in <head> (before the page\'s own stylesheet), with the theme\'s colour and scheme',
        first > 0 && first < wb.body.indexOf('<meta charset') && wb.body.includes(`:where(html){background:${seededBg};`) && /color-scheme:dark\}/.test(wb.body.slice(first, first + 300)), wb.body.slice(first, first + 160));
    }
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
    hostServer = createDashboardStandin({ repoRoot: APP_ROOT, launcherPort: PORT, secret: SECRET, recentDirs: [workspace], chatCwd: chatProject, mintLink: () => gatewayMock.mintLink() });
    await new Promise((ok) => hostServer.listen(hostPort, '127.0.0.1', ok));
    // A persistent profile, so browser-side VS Code state can be checked across
    // a launcher restart (step 15).
    const profileDir = path.join(runDir, 'browser-profile');
    browser = await pw.chromium.launchPersistentContext(profileDir, { executablePath: exe, headless: true, viewport: { width: 1400, height: 900 } });
    const page = browser.pages()[0] || (await browser.newPage());
    {
      // The icon files app.json names, from the copy under test (the staged
      // copy with --app-root): present, and SVGs parse as SVG in a real parser.
      const icons = manifestIconFiles(APP_ROOT);
      const bad = [];
      for (const { field, file } of icons) {
        if (!fs.existsSync(file)) { bad.push(`${field} missing`); continue; }
        const buf = fs.readFileSync(file);
        if (file.endsWith('.png')) { if (!isPng(buf)) bad.push(`${field} not a PNG`); continue; }
        const text = buf.toString('utf8');
        const local = svgProblems(text);
        const parsed = await page.evaluate((t) => {
          const d = new DOMParser().parseFromString(t, 'image/svg+xml');
          return d.querySelector('parsererror') ? 'parsererror' : d.documentElement.namespaceURI + ' ' + d.documentElement.localName;
        }, text);
        if (local.length || parsed !== 'http://www.w3.org/2000/svg svg') bad.push(`${field}: ${[...local, parsed].join('; ')}`);
      }
      check('app.json icon files exist and parse as SVG/PNG', icons.length >= 3 && !bad.length, bad.join(' | ') || `${icons.length} files`);
    }
    const frameErrors = [];
    const pageErrors = [];
    // Every workbench page load (the frame's own document), to prove a remount does not reload it.
    let workbenchLoads = 0;
    // Webviews must come from the self-hosted loopback endpoint, never the CDN
    // (VS Code's own product fetches from main.vscode-cdn.net are not webviews).
    const cdnRequests = [];
    browserCdn = cdnRequests;
    page.on('request', (r) => {
      if (/vscode-cdn\.net\/.*\/contrib\/webview\//.test(r.url())) cdnRequests.push(r.url().slice(0, 100));
      if (r.resourceType() === 'document' && r.url().startsWith(`http://127.0.0.1:${framePort}/vsc-`)) workbenchLoads++;
    });
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
    const loadWatch = await startLoadWatch({ page, framePort });
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
    {
      const loadResult = await loadWatch.stop();
      const loadShots = path.join(ROOT, '.cache', 'smoke');
      fs.mkdirSync(loadShots, { recursive: true });
      // The stand-in's dark palette: --bg #21222c (scripts/lib/dashboard-standin.mjs).
      loadChecks({ result: loadResult, expectBg: [33, 34, 44], shotDir: loadShots, check });
      const rdy = await page.locator('iframe[title="VS Code"]').evaluate((f) => ({ ready: f.getAttribute('data-ready'), opacity: getComputedStyle(f).opacity }));
      check('once the workbench page has loaded the iframe is revealed (data-ready true, opacity 1)', rdy.ready === 'true' && rdy.opacity === '1', JSON.stringify(rdy));
    }

    // 6a. the first chat message in this fresh browser profile is a plain one
    //     (no @mention), typed into the Chat view as soon as the workbench is
    //     up. VS Code sends it with the picker's current model; with no model
    //     selected the extension host fails it with "Language model unavailable"
    //     before any participant runs (extHostLanguageModels.ts).
    const firstPrompt = `Hello ${crypto.randomBytes(3).toString('hex')}`;
    let firstSent = '';
    if (workbenchUp) {
      const t6a = Date.now();
      try {
        const box = frame.locator('.interactive-input-editor .monaco-editor').first();
        let open = await box.isVisible().catch(() => false);
        for (let attempt = 0; attempt < 6 && !open; attempt++) {
          await frame.locator('.monaco-workbench').click({ position: { x: 700, y: 300 } });
          await page.keyboard.press('Control+Alt+KeyI');
          open = await box.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
        }
        if (!open) throw new Error('the Chat view did not open');
        await box.click();
        await page.keyboard.type(firstPrompt, { delay: 10 });
        await page.keyboard.press('Enter');
        firstSent = `sent ${Date.now() - t6a} ms after the workbench rendered`;
      } catch (e) {
        firstSent = '';
        console.log(`first chat message not sent: ${e.message}`);
      }
    }
    let firstTurn = null;
    let firstFailed = false;
    const t6b = Date.now();
    while (firstSent && Date.now() - t6b < 90_000) {
      firstTurn = gatewayMock.rec.turns.find((t) => String(t.message).startsWith(firstPrompt));
      firstFailed = (await frame.locator('text=Language model unavailable').count().catch(() => 0)) > 0;
      if (firstTurn || firstFailed) break;
      await sleep(500);
    }
    let firstReply = false;
    if (firstTurn) firstReply = await frame.locator('text=Kiro Crew mock').first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
    await page.screenshot({ path: path.join(ROOT, '.cache', 'smoke', 'first-chat.png') }).catch(() => {});
    if (!check(
      'a first plain chat message in a fresh profile reaches Kiro Crew and gets its reply (no "Language model unavailable")',
      firstSent && firstTurn && firstReply && !firstFailed,
      `${firstSent || 'not sent'}; turn ${firstTurn ? 'seen' : 'missing'}; reply ${firstReply}; model error ${firstFailed}`,
    )) console.log('workbench console (chat):\n  ' + chatConsole.slice(-20).join('\n  '));

    // 6n. VS Code's own Chat on Kiro Crew sessions: the "Kiro Crew" chat
    //     session type (tool cards, approvals, sessions, the toggle), the
    //     Copilot agents setting, and history restored after a window reload.
    if (workbenchUp && firstTurn) {
      const native = await nativeChatChecks({ page, frame, api, check, gatewayMock, workspace, firstTurn, root: ROOT });
      await copilotAgentChecks({ api, check, machineFile: path.join(dataDir, 'server-data', 'data', 'Machine', 'settings.json') });
      const tR = Date.now();
      await page.reload();
      await frame.locator('.monaco-workbench').waitFor({ timeout: 60_000 }).catch(() => {});
      for (let i = 0; i < 120; i++) {
        const st = (await api('GET', '/api/state')).json;
        if (st && st.extension && Date.parse(st.extension.at) > tR) break;
        await sleep(500);
      }
      await historyChecks({ frame, api, check, slot: native.s1, since: tR });
      await sessionTargetChecks({ page, frame, check, shotDir: path.join(ROOT, '.cache', 'smoke') });
      await extensionIconChecks({ page, frame, check, appRoot: APP_ROOT, dataDir, shotDir: path.join(ROOT, '.cache', 'smoke') });
      await page.screenshot({ path: path.join(ROOT, '.cache', 'smoke', 'native-chat.png') }).catch(() => {});
    } else {
      check('native chat session checks ran', false, 'the workbench or the first chat turn was missing');
    }
    if (NATIVE_ONLY) throw new StopEarly('--native-only');

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
    check('the bridge secret is gone from the extension host environment once the bridge has read it', st && st.extension && st.extension.secretInEnv === false, st && st.extension && String(st.extension.secretInEnv));

    // 7a. secret storage: the serve-web key scheme through the frame proxy, and
    //     a secret stored through the bridge's context.secrets (read back after
    //     the reload in 14 and the launcher restarts in 14b and 15)
    const secretValue = `smoke-secret-${crypto.randomBytes(6).toString('hex')}`;
    await secretChecks({ page, api, check, rawRequest, framePort, wbPath: wbUrl.pathname + wbUrl.search, dataDir, value: secretValue });

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
    check(
      'bridge published the Kiro Crew language model to the workbench at activation',
      cs0 && cs0.extension.chat && cs0.extension.chat.model === true && cs0.extension.chat.modelPublished === true,
      JSON.stringify(cs0 && cs0.extension.chat),
    );
    const prompt = `smoke ${crypto.randomBytes(3).toString('hex')}: say hi`;
    // Replies already in the Chat view (step 6a), so the check below waits for a new one.
    const repliesBefore = await frame.locator('text=Kiro Crew mock').count().catch(() => 0);
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
    // With the Kiro Crew session type as the default, the Chat view's chat is
    // a Kiro Crew session: one slot per VS Code chat, pointed at the folder.
    check(
      "the turn ran in a Kiro Crew session slot pointed at the workspace folder",
      turn && isSessionSlot(turn.slot, workspace) && String(gatewayMock.rec.slots.get(turn.slot)?.project).toLowerCase() === workspace.toLowerCase(),
      turn && `${turn.slot} project=${gatewayMock.rec.slots.get(turn.slot)?.project}`,
    );
    let chatShown = false;
    for (const tr = Date.now(); Date.now() - tr < 20_000 && !chatShown; await sleep(300)) {
      chatShown = (await frame.locator('text=Kiro Crew mock').count().catch(() => 0)) > repliesBefore;
    }
    check('the Kiro Crew reply streams into the VS Code Chat view', chatShown, `${repliesBefore} replies before`);
    let cs1 = null;
    const t7b = Date.now();
    while (Date.now() - t7b < 10_000) {
      cs1 = (await api('GET', '/api/chat/status')).json;
      if (cs1 && cs1.lastTurn) break;
      await sleep(300);
    }
    check('chat status records the finished turn', cs1 && cs1.lastTurn && cs1.lastTurn.outcome === 'done' && cs1.turns >= 1, JSON.stringify(cs1 && cs1.lastTurn));

    // 7b-2. an Update leaves the new chat permissions unapproved: the gateway
    //       answers the app token with its out-of-scope 403
    {
      const noteSel = '[data-testid="vscode-pane-chat-problem"]';
      gatewayMock.deny(['/api/chat', '/api/status']);
      const denied = (await api('GET', '/api/chat/status?probe=1')).json;
      check(
        'GET /api/chat/status names unapproved chat permissions after a gateway 403',
        denied && denied.available === false && denied.permission && denied.permission.denied === true && /approve the new API permissions/.test(denied.reason || '') &&
          JSON.stringify(denied.permission.needed) === '["/api/chat","/api/chat/slots","/api/status"]',
        JSON.stringify(denied && { available: denied.available, reason: denied.reason, permission: denied.permission }),
      );
      const note = await page.locator(noteSel).textContent({ timeout: 8000 }).catch(() => '');
      check('the pane shows the unapproved-permissions note', /approve the new API permissions/.test(note || ''), (note || '').slice(0, 120));
      gatewayMock.deny([]);
      const ok = (await api('GET', '/api/chat/status?probe=1')).json;
      let gone = false;
      for (let i = 0; i < 20 && !gone; i++) {
        gone = (await page.locator(noteSel).count()) === 0;
        if (!gone) await sleep(500);
      }
      check('once approved, chat is available again and the note goes away', ok && ok.available === true && ok.permission && ok.permission.denied === false && gone, JSON.stringify(ok && ok.permission));
    }

    // 7b-3. the chat session was closed in Kiro Crew: the next turn recreates it
    {
      const slotKey = turn ? turn.slot : slotNameFor(workspace);
      gatewayMock.closeSlot(slotKey);
      const prompt2 = `smoke ${crypto.randomBytes(3).toString('hex')}: after close`;
      const ask2 = await api('POST', '/api/chat/ask', { prompt: prompt2 });
      let turn2 = null;
      const tc = Date.now();
      while (Date.now() - tc < 30_000) {
        turn2 = gatewayMock.rec.turns.find((t) => String(t.message).startsWith(prompt2));
        if (turn2) break;
        await sleep(300);
      }
      check(
        'a Kiro Crew session closed in Kiro Crew is recreated with its project on the next turn',
        ask2.json && ask2.json.ok && turn2 && turn2.slot === slotKey && String(gatewayMock.rec.slots.get(slotKey)?.project).toLowerCase() === workspace.toLowerCase(),
        turn2 ? `${turn2.slot} project=${gatewayMock.rec.slots.get(slotKey)?.project}` : `turns: ${gatewayMock.rec.turns.length}`,
      );
      let cs2b = null;
      const td = Date.now();
      while (Date.now() - td < 15_000) {
        cs2b = (await api('GET', '/api/chat/status')).json;
        if (cs2b && cs2b.turns >= 2 && cs2b.activeTurns === 0) break;
        await sleep(300);
      }
      check('the turn after the recreate finishes', cs2b && cs2b.turns >= 2 && cs2b.lastTurn && cs2b.lastTurn.outcome === 'done', JSON.stringify(cs2b && cs2b.lastTurn));
    }
    fs.mkdirSync(path.join(ROOT, '.cache', 'smoke'), { recursive: true });
    await page.screenshot({ path: path.join(ROOT, '.cache', 'smoke', 'chat.png') });

    // 7c. theme: the page POSTs the dashboard palette on mount (replacing the
    //     seeded one, checked in 3b); the launcher keeps it as a full palette and
    //     the bridge writes it, then a new one is posted live
    const mountPost = hostServer.themePosts.find((p) => p.body && p.body.kind === 'dark' && p.body.vars);
    const stored = (await api('GET', '/api/theme')).json;
    check(
      "the page's mount POST is stored as tier \"palette\" (every token it sends is accepted)",
      mountPost && stored && stored.theme && stored.theme.tier === 'palette' && stored.theme.vars['--bg'] === mountPost.body.vars['--bg'],
      JSON.stringify(stored && stored.theme && { tier: stored.theme.tier, reason: stored.theme.reason, bg: stored.theme.vars && stored.theme.vars['--bg'] }),
    );
    const storedVs = stored && stored.theme ? toVsCodeTheme(stored.theme) : null;
    let th = null;
    const t8 = Date.now();
    while (Date.now() - t8 < 20_000) {
      th = (await api('GET', '/api/state')).json?.theme;
      if (th && th.applied && th.readBack && storedVs && th.readBack.editorBackground === storedVs.colorCustomizations['editor.background']) break;
      await sleep(300);
    }
    check(
      'bridge wrote the stored palette to the user settings (read back through the bridge)',
      storedVs && th && th.applied && th.readBack && th.readBack.colorTheme === 'Dark Modern' && th.readBack.editorBackground === storedVs.colorCustomizations['editor.background'] &&
        th.readBack.count === Object.keys(storedVs.colorCustomizations).length,
      JSON.stringify(th && th.readBack),
    );
    const badTheme = await api('POST', '/api/theme', { kind: 'sepia' });
    check('POST /api/theme refuses a body without a valid kind', badTheme.status === 400, `${badTheme.status} ${badTheme.json && badTheme.json.error}`);
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
      if (th2 && th2.readBack && th2.readBack.colorTheme === 'Light Modern' && th2.readBack.count > 0) break;
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

    // 7d. tier 2: a palette that fails the contrast check falls back to the
    //     stock theme and the earlier palette is cleared from VS Code
    const weak = await api('POST', '/api/theme', { kind: 'light', vars: { '--bg': '#fbf7ef', '--text': '#f0e8da' } });
    check('a low-contrast palette is accepted as tier "base"', weak.status === 200 && weak.json.theme?.tier === 'base', JSON.stringify(weak.json && weak.json.theme && { tier: weak.json.theme.tier, reason: weak.json.theme.reason }));
    let th5 = null;
    const t9c = Date.now();
    while (Date.now() - t9c < 20_000) {
      th5 = (await api('GET', '/api/state')).json?.theme;
      if (th5 && th5.readBack && th5.readBack.count === 0) break;
      await sleep(300);
    }
    check('tier "base" clears the palette in VS Code (no colorCustomizations left)', th5 && th5.readBack && th5.readBack.count === 0 && th5.readBack.colorTheme === 'Light Modern', JSON.stringify(th5 && th5.readBack));
    const sess5 = (await api('GET', '/api/session')).json;
    check('session state reports the active theme tier', sess5 && sess5.theme && sess5.theme.tier === 'base' && sess5.theme.kind === 'light', JSON.stringify(sess5 && sess5.theme));
    const restore = await api('POST', '/api/theme', POSTED_THEME);
    let th6 = null;
    const t9d = Date.now();
    while (Date.now() - t9d < 20_000) {
      th6 = (await api('GET', '/api/state')).json?.theme;
      if (th6 && th6.readBack && th6.readBack.count > 0) break;
      await sleep(300);
    }
    check('posting a sound palette again returns to tier "palette"', restore.json?.theme?.tier === 'palette' && th6 && th6.readBack && th6.readBack.count === Object.keys(wantVs.colorCustomizations).length, JSON.stringify(th6 && th6.readBack));

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

    // The composer chip left the pane on the chat project (and remembered it);
    // take it back to the workspace folder with hello.txt open for steps 13-15.
    {
      const tBack = Date.now();
      await page.goto(`http://localhost:${hostPort}/apps/vscode-pane?folder=${encodeURIComponent(workspace)}`);
      await frame.locator('.monaco-workbench').waitFor({ timeout: 60_000 }).catch(() => {});
      let stBack = null;
      while (Date.now() - tBack < 60_000) {
        stBack = (await api('GET', '/api/state')).json;
        if (stBack && stBack.extension && Date.parse(stBack.extension.at) > tBack) break;
        await sleep(500);
      }
      const reopenWs = await api('POST', '/api/open', { path: target, line: 2 });
      check('the pane goes back to the workspace folder and opens hello.txt', stBack && stBack.extension && Date.parse(stBack.extension.at) > tBack && reopenWs.json && reopenWs.json.ok, JSON.stringify(reopenWs.json));
      await sleep(3000); // let the workbench flush its storage
    }

    // 12b. the Kiro Crew tab in VS Code's secondary side bar, with the real
    //      ChatPanel (the stand-in's stub) drawn over it (ui/vscode-pane-crew-*.mjs)
    await tabChecks({ page, frame, api, hostServer, gatewayMock, workspace, shotDir, check, framePort, dataDir, rawRequest, cdnRequests: browserCdn });

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
      if (!(st3 && st3.activeEditor)) {
        await page.screenshot({ path: path.join(ROOT, '.cache', 'smoke', 'reload-no-editor.png') }).catch(() => {});
        console.log('after reload, /api/state:', JSON.stringify(st3 && { connected: st3.connected, at: st3.extension && st3.extension.at, active: st3.activeEditor }));
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
      await secretReadBack({ api, check, value: secretValue, label: 'after a reload of the page' });
      const back2 = await api('POST', '/api/open', { path: target, line: 2 });
      check('hello.txt reopened for the restart check', back2.json && back2.json.ok);
      await sleep(3000); // let the workbench flush its storage
    }

    // 14b. restart the backend while the page stays open (an app disable and
    //      enable, an Update, a gateway restart): the page sees the new run id
    //      and frame URL and reloads the kept-alive frame with no user action
    if (process.platform === 'win32') {
      const s0 = (await api('GET', '/api/session')).json;
      const url0 = new URL(s0.url);
      const loads0 = await page.evaluate(() => window.__vscodePane.loads);
      earlierTree.push(...descendants(processTable(), launcher.pid));
      spawnSync('taskkill', ['/PID', String(launcher.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      await sleep(1500);
      PORT = await freePort();
      launcher = startLauncher(PORT);
      hostServer.setLauncherPort(PORT);
      const tR = Date.now();
      let s1 = null;
      while (Date.now() - tR < 120_000) {
        s1 = (await api('GET', '/api/session').catch(() => ({ json: null }))).json;
        if (s1 && (s1.ready || s1.status === 'error')) break;
        await sleep(500);
      }
      const url1 = s1 && s1.url ? new URL(s1.url) : null;
      check(
        'a restarted backend has a new run id and frame path key on the same frame origin',
        url1 && s1.instance && s1.instance !== s0.instance && url1.origin === url0.origin && url1.pathname !== url0.pathname,
        url1 ? `run ${s0.instance} -> ${s1.instance}; frame ${url0.port} -> ${url1.port}` : 'not ready',
      );
      const logR = fs.readFileSync(path.join(dataDir, 'logs', 'launcher.log'), 'utf8');
      const spawnedR = [...logR.matchAll(/server spawned pid (\d+) port (\d+)/g)];
      if (spawnedR.length) serverPort = Number(spawnedR.at(-1)[2]);
      let src1 = '';
      let st1 = null;
      while (Date.now() - tR < 150_000) {
        src1 = (await page.locator('iframe[title="VS Code"]').getAttribute('src').catch(() => '')) || '';
        st1 = (await api('GET', '/api/state')).json;
        if (url1 && src1.startsWith(url1.origin + url1.pathname) && st1 && st1.extension && Date.parse(st1.extension.at) > tR) break;
        await sleep(500);
      }
      const loads1 = await page.evaluate(() => window.__vscodePane.loads);
      check(
        'with the page still open, the pane reloads the frame on the new URL and the bridge reconnects, with no user action',
        url1 && src1.startsWith(url1.origin + url1.pathname) && loads1 === loads0 + 1 && st1 && st1.extension && Date.parse(st1.extension.at) > tR,
        `frame loads ${loads0} -> ${loads1}; hello ${st1 && st1.extension && st1.extension.at}`,
      );
      const dead = await frame.locator('text=/Cannot reconnect|connection token/i').count().catch(() => 0);
      const reopenR = await api('POST', '/api/open', { path: target, line: 2 });
      check('the reloaded workbench is live (no reconnect error, /api/open works)', dead === 0 && reopenR.json && reopenR.json.ok, JSON.stringify(reopenR.json));
      await secretReadBack({ api, check, value: secretValue, label: 'after a launcher restart with the page open (new frame path key)' });
      await tunnelPersists({ api, check, gatewayMock, label: 'after a launcher restart with the page open' });
      await sleep(3000); // let the workbench flush its storage
    }

    // 15. restart the launcher with the dashboard closed (a gateway restart):
    //     same frame origin, a new path key, and the workbench comes back with
    //     its editor from browser storage
    if (process.platform === 'win32') {
      const urlBefore = new URL((await api('GET', '/api/session')).json.url);
      const themeBeforeRestart = (await api('GET', '/api/theme')).json?.theme;
      earlierTree.push(...descendants(processTable(), launcher.pid));
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
        'after a launcher restart on a new API port, the frame keeps its origin and gets a new path key',
        urlAfter && PORT !== firstLauncherPort && urlAfter.origin === urlBefore.origin && urlAfter.pathname !== urlBefore.pathname,
        urlAfter ? `api ${firstLauncherPort} -> ${PORT}; frame ${urlBefore.port} -> ${urlAfter.port}` : 'not ready',
      );
      const logNow = fs.readFileSync(path.join(dataDir, 'logs', 'launcher.log'), 'utf8');
      const spawnedNow = [...logNow.matchAll(/server spawned pid (\d+) port (\d+)/g)];
      if (spawnedNow.length) serverPort = Number(spawnedNow.at(-1)[2]);
      hostServer = createDashboardStandin({ repoRoot: APP_ROOT, launcherPort: PORT, secret: SECRET, recentDirs: [workspace], mintLink: () => gatewayMock.mintLink() });
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
      const themeAfterRestart = (await api('GET', '/api/theme')).json?.theme;
      const wantAfter = themeBeforeRestart ? toVsCodeTheme(themeBeforeRestart) : null;
      check(
        'after the launcher restart the stored theme is still in effect, not rewritten',
        wantAfter && th4 && th4.readBack && th4.readBack.colorTheme === wantAfter.colorTheme && th4.readBack.editorBackground === (wantAfter.colorCustomizations['editor.background'] ?? null) &&
          themeAfterRestart && themeAfterRestart.updatedAt === themeBeforeRestart.updatedAt,
        JSON.stringify({ readBack: th4 && th4.readBack, tier: themeBeforeRestart && themeBeforeRestart.tier, updatedAt: [themeBeforeRestart && themeBeforeRestart.updatedAt, themeAfterRestart && themeAfterRestart.updatedAt] }),
      );
      await page2.screenshot({ path: path.join(ROOT, '.cache', 'smoke', 'after-restart.png') });
      await secretReadBack({ api, check, value: secretValue, label: 'after a launcher restart and a browser restart on the same profile' });
      await tunnelPersists({ api, check, gatewayMock, label: 'after a launcher restart and a browser restart', page: page2 });
      const cs2 = (await api('GET', '/api/chat/status?probe=1')).json;
      check('after the launcher restart chat is available again with a fresh app token', cs2 && cs2.available && cs2.gateway.reachable === true, JSON.stringify(cs2 && cs2.gateway && { reachable: cs2.gateway.reachable, lastError: cs2.gateway.lastError }));
    }
  } catch (e) {
    if (!(e instanceof StopEarly)) check('smoke run completed without exception', false, e.message);
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
