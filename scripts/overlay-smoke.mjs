#!/usr/bin/env node
// Real-browser check of the Kiro Crew tab overlay on the app web origin (a remote
// crew's viewer): a real launcher and VS Code server, a mock gateway (dashboard
// chat page, sign-in), and headless Chrome or Chromium driven over CDP with no
// extra packages. The browser reaches the launcher as
// http://vscode-pane.apps.localhost:<port>, the name the gateway's relay serves.
//
//   VSCODE_PANE_SERVER_DIR=<a VS Code server build> [SMOKE_BROWSER=<chrome>] node scripts/overlay-smoke.mjs
//
// Needs Node 22 or later (the global WebSocket) and a server build with its node.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGatewayMock } from '../test/support/gateway-mock.mjs';
import { findBrowser } from './lib/browser.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-overlay-'));
const CHROME = process.env.SMOKE_BROWSER || findBrowser();
const SERVER_DIR = process.env.VSCODE_PANE_SERVER_DIR;
if (!CHROME || !SERVER_DIR) {
  console.log('Set VSCODE_PANE_SERVER_DIR (a VS Code server build) and SMOKE_BROWSER (a Chrome or Chromium binary).');
  process.exit(2);
}
const PORT = 47971;
const CDP = 9444;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' -- ' + detail : ''}`);
};

const mock = createGatewayMock({ appName: 'vscode-pane', secret: 's' });
const gwOrigin = await mock.listen();
fs.mkdirSync(`${S}/kc-data`, { recursive: true });

const launcher = spawn(process.execPath, ['backend/launcher.mjs'], {
  cwd: APP,
  env: { ...process.env, PORT: String(PORT), VSCODE_PANE_DATA_DIR: `${S}/kc-data`, VSCODE_PANE_SERVER_DIR: SERVER_DIR, VSCODE_PANE_ALLOW_UNSIGNED: '1', KIROCREW_GATEWAY_ORIGIN: gwOrigin, VSCODE_PANE_VERBOSE: '1', VSCODE_PANE_DASHBOARD_ORIGIN: 'http://127.0.0.1:47972' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
let launcherLog = '';
launcher.stdout.on('data', (d) => (launcherLog += d));
launcher.stderr.on('data', (d) => (launcherLog += d));

async function api(path, method = 'GET', body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}

let chrome = null;
let topServer = null;
try {
  let session;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      session = (await api(`/api/session?folder=${encodeURIComponent(APP)}`)).json;
      if (session && session.ready) break;
    } catch {}
  }
  check('launcher ready', !!session && session.ready, session && session.status);
  const signed = await api('/api/kc/sign-in', 'POST', { url: mock.mintLink(gwOrigin) });
  check('Kiro Crew tab signed in', signed.status === 200 && signed.json && signed.json.ok, JSON.stringify(signed.json).slice(0, 160));
  // A tab opened from a chat (the composer chip): its window shows that chat.
  const opened = (await api('/api/tabs/open', 'POST', { folder: APP, session: 'chat-overlay-1' })).json;
  check('a tab opens for the chat', !!(opened && opened.tab && opened.tab.session === 'chat-overlay-1'), JSON.stringify(opened).slice(0, 200));
  const tabUrl = (await api('/api/session')).json.tabs.list.find((t) => t.id === opened.tab.id).url;

  const u = new URL(tabUrl);
  // The page loads each tab with ?vscpTab=<id> (ui/vscode-pane-core-*.mjs tabWorkbenchUrl).
  const webUrl = `http://vscode-pane.apps.localhost:${PORT}${u.pathname}${u.search}&vscpTab=${opened.tab.id}`;
  topServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><body style="margin:0"><iframe id="wb" src="${webUrl}" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe></body>`);
  });
  await new Promise((ok) => topServer.listen(47972, '127.0.0.1', ok));
  const topPort = topServer.address().port;

  chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${CDP}`, `--user-data-dir=${S}/chrome-prof`, '--disable-features=IsolateOrigins,site-per-process,Translate', '--remote-allow-origins=*', '--window-size=1500,950', 'about:blank'], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      targets = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {}
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let id = 0;
  const pending = new Map();
  const contexts = new Map(); // contextId -> {frameId, origin}
  const key = (sid, cid) => `${sid || ''}:${cid}`;
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    } else if (d.method === 'Target.attachedToTarget') {
      const sid = d.params.sessionId;
      send('Runtime.enable', {}, sid);
      send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid);
      send('Runtime.runIfWaitingForDebugger', {}, sid);
    } else if (d.method === 'Runtime.executionContextCreated') {
      const c = d.params.context;
      contexts.set(key(d.sessionId, c.id), { sid: d.sessionId, cid: c.id, origin: c.origin, name: c.name });
    } else if (d.method === 'Runtime.executionContextDestroyed') contexts.delete(key(d.sessionId, d.params.executionContextId));
    else if (d.method === 'Runtime.executionContextsCleared') {
      for (const k of [...contexts.keys()]) if (k.startsWith(`${d.sessionId || ''}:`)) contexts.delete(k);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((ok) => {
    const i = ++id;
    pending.set(i, ok);
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const evalIn = async (ctx, expr) => {
    const r = await send('Runtime.evaluate', { contextId: ctx.cid, expression: expr, returnByValue: true, awaitPromise: true }, ctx.sid);
    if (r.error || (r.result && r.result.exceptionDetails)) console.log('eval problem', JSON.stringify(r.error || r.result.exceptionDetails).slice(0, 300));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await send('Page.navigate', { url: `http://127.0.0.1:${topPort}/` });

  const ctxWhere = (pred) => [...contexts.values()].filter(pred);
  const workbenchCtx = () => ctxWhere((c) => c.origin === `http://vscode-pane.apps.localhost:${PORT}` && !c.name)[0];

  // Wait for the workbench, the extension and the Kiro Crew tab's webview iframe.
  let wb;
  let info = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    wb = workbenchCtx();
    if (!wb) continue;
    info = await evalIn(wb, `(() => { const l=[...document.querySelectorAll('iframe.webview')].map(f=>f.getAttribute('src')||''); const k=l.find(s=>/extensionid=kiro-crew\\.kiro-crew-bridge/i.test(s)); return {n:l.length, kiro: !!k, script: !!document.querySelector('script[src$="/_vscp-kc.js"]'), cookie: document.cookie}; })()`);
    if (info && info.kiro) break;
  }
  check('workbench page carries the overlay script', !!(info && info.script), JSON.stringify(info).slice(0, 200));
  check('the Kiro Crew tab has a webview iframe naming the bridge extension', !!(info && info.kiro), JSON.stringify(info).slice(0, 200));
  check('the viewer cookie is not readable by script (HttpOnly)', !!info && !/vscp-viewer/.test(info.cookie || ''));

  // The overlay: a same-origin iframe of the dashboard chat, over the webview.
  let ov = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    wb = workbenchCtx();
    ov = await evalIn(wb, `(() => { const b=document.querySelector('[data-vscp-kc-overlay]'); const f=b&&b.querySelector('iframe'); const w=[...document.querySelectorAll('iframe.webview')].find(x=>/extensionid=kiro-crew\\.kiro-crew-bridge/i.test(x.getAttribute('src')||'')); if(!b||!f||!w) return null; const r=b.getBoundingClientRect(), q=w.getBoundingClientRect(); return {shown:getComputedStyle(b).display, src:f.getAttribute('src'), same: Math.abs(r.left-q.left)<2&&Math.abs(r.top-q.top)<2&&Math.abs(r.width-q.width)<2&&Math.abs(r.height-q.height)<2, rect:[r.left,r.top,r.width,r.height].map(Math.round), wrect:[q.left,q.top,q.width,q.height].map(Math.round)}; })()`);
    if (ov && ov.shown === 'block') break;
  }
  check('overlay is shown over the tab', !!ov && ov.shown === 'block', JSON.stringify(ov));
  check('overlay follows the webview rectangle', !!ov && ov.same, JSON.stringify(ov));
  check('overlay frames the chat the tab was opened from (/embed/chat/<key>?sid=<key>), and no session was created', !!ov && ov.src === '/embed/chat/chat-overlay-1?sid=chat-overlay-1' && mock.rec.slots.size === 0, ov && `${ov.src}; slots ${mock.rec.slots.size}`);

  // The chat page itself rendered inside the overlay.
  let chatText = '';
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const ids = ctxWhere((c) => c.origin === `http://vscode-pane.apps.localhost:${PORT}`);
    for (const cid of ids) {
      const t = await evalIn(cid, `document.body ? document.body.innerText : ''`);
      if (t && /Kiro Crew mock dashboard/.test(t)) chatText = t;
    }
    if (chatText) break;
  }
  check('the dashboard chat page renders in the overlay', /Kiro Crew mock dashboard/.test(chatText), chatText.slice(0, 80));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${S}/kc-overlay.png`, Buffer.from(shot.result.data, 'base64'));
  console.log(`screenshot: ${S}/kc-overlay.png`);
  const wsOk = mock.rec.dash && mock.rec.dash.wsOpens;
  check('the chat page opened its WebSocket through the web origin', wsOk > 0, `wsOpens=${wsOk}`);

  // Without the viewer cookie the chat is not served.
  const noCookie = await fetch(`http://127.0.0.1:${PORT}/embed/chat/x`, { headers: { Host: `vscode-pane.apps.localhost:${PORT}` } });
  check('the chat on the web origin is refused without the viewer cookie', noCookie.status === 404, `status ${noCookie.status}`);
} catch (e) {
  console.log('ERROR', e.stack || e.message);
  results.push(false);
} finally {
  try { chrome && process.kill(chrome.pid, 'SIGKILL'); } catch {}
  try { process.kill(-launcher.pid, 'SIGTERM'); } catch {}
  await sleep(1000);
  try { process.kill(-launcher.pid, 'SIGKILL'); } catch {}
  topServer && topServer.close();
  await mock.close();
  if (results.every(Boolean)) fs.rmSync(`${S}/kc-data`, { recursive: true, force: true });
  if (!results.every(Boolean)) console.log('--- launcher log tail\n' + launcherLog.split('\n').slice(-25).join('\n'));
}
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
process.exit(results.every(Boolean) ? 0 : 1);
