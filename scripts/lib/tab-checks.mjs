// Smoke checks for the Kiro Crew tab in VS Code's secondary side bar: the
// bridge's webview view framing Kiro Crew's own dashboard chat through the
// launcher's tunnel (backend/lib/kcproxy.mjs), the three sign-in mechanisms
// (automatic from the page, Connect in the tab, a pasted link), Disconnect,
// containment, the self-hosted webview endpoint and the chip. The dashboard
// behind the tunnel is the mock gateway's (test/support/dashboard-mock.mjs),
// not the real Kiro Crew SPA.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { slotNameFor } from '../../backend/lib/gateway.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 10_000, step = 250) {
  const t = Date.now();
  let v;
  while (Date.now() - t < ms) {
    v = await fn().catch(() => null);
    if (v) return v;
    await sleep(step);
  }
  return v;
}

const EMBED_RE = /^http:\/\/[0-9a-f]{32}\.localhost:\d+\/embed\/chat\//;

/** The tunnelled /embed/chat frame inside the webview, or null. */
function embedFrame(page) {
  return page.frames().find((f) => EMBED_RE.test(f.url())) || null;
}

/** The webview's own document (crewview.js HTML), found by its data-mode. */
async function viewFrame(page, framePort) {
  for (const f of page.frames()) {
    if (!new RegExp(`^http://[a-z0-9]+\\.localhost:${framePort}/`).test(f.url())) continue;
    const mode = await f.evaluate(() => (document.body && document.body.dataset.mode) || '').catch(() => '');
    if (mode) return { frame: f, mode };
  }
  return null;
}

/** Act in the webview's sign-in panel; it may be redrawn under us, so find it afresh each try. */
async function inView(page, framePort, fn, ms = 20_000) {
  const t = Date.now();
  let last = null;
  while (Date.now() - t < ms) {
    const v = await viewFrame(page, framePort);
    if (v && v.mode === 'signin') {
      try {
        await fn(v.frame);
        return true;
      } catch (e) {
        last = e;
      }
    }
    await sleep(400);
  }
  const seen = [];
  for (const f of page.frames()) {
    if (!/\.localhost:/.test(f.url())) continue;
    seen.push(`${f.url().replace(/^http:\/\/([a-z0-9]{6})[a-z0-9]*/, 'http://$1…').replace(/\?.*/, '').slice(0, 90)} mode=${await f.evaluate(() => (document.body && document.body.dataset.mode) || '-').catch((e) => 'ERR ' + e.message.slice(0, 40))}`);
  }
  throw new Error(`the sign-in panel never showed (${last ? last.message.split('\n')[0] : 'no panel'}); frames: ${seen.join(' | ')}`);
}

async function embedState(page) {
  const f = embedFrame(page);
  if (!f) return null;
  return f.evaluate(() => ({
    url: location.href,
    state: (document.getElementById('state') || {}).textContent || '',
    ws: (document.getElementById('ws') || {}).textContent || '',
    slot: (document.getElementById('slot') || {}).textContent || '',
  })).catch(() => null);
}

async function focusWorkbench(frame) {
  await frame.locator('.monaco-workbench .part.editor').first().click({ position: { x: 200, y: 160 } }).catch(() => {});
}

/** Run a VS Code command by its palette title. */
async function runCommand(page, frame, title) {
  await focusWorkbench(frame);
  await page.keyboard.press('Control+Shift+KeyP');
  await frame.locator('.quick-input-widget input').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await page.keyboard.type(title, { delay: 5 });
  await sleep(600);
  await page.keyboard.press('Enter');
  await sleep(400);
}

async function clearNotifications(page, frame) {
  if ((await frame.locator('.notifications-toasts.visible .notification-toast-container').count().catch(() => 0)) === 0) return;
  await runCommand(page, frame, 'Notifications: Clear All Notifications');
}

async function auxTabs(frame) {
  return frame.locator('.part.auxiliarybar .composite-bar .action-item').evaluateAll((els) => els.map((e) => ({
    label: (e.querySelector('.action-label') || e).getAttribute('aria-label') || '',
    active: e.classList.contains('checked') || !!e.querySelector('.action-label.checked'),
  })));
}

const signedIn = async (page) => {
  const s = await embedState(page);
  return s && /Signed in to Kiro Crew mock/.test(s.state) && /hello from the mock gateway/.test(s.ws) ? s : null;
};

/**
 * Geometry of the tunnelled /embed/chat inside its frame (run in that frame):
 * the embed shell (the #root child holding [data-chat-scope]) against the
 * viewport, every box from <html> down to the outermost chat pane (margin,
 * padding, border, radius, shadow), the pane's left, right and bottom edges,
 * overflow, and the composer's glass pane, which keeps its own card.
 */
export function embedEdges() {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const pane = document.querySelector('[data-chat-scope]');
  const shell = pane && Array.from(document.querySelectorAll('#root > div')).find((d) => d.contains(pane));
  if (!pane || !shell) return { error: 'no embed shell or chat pane' };
  const px = (v) => Math.round(parseFloat(v) * 100) / 100 || 0;
  const bad = [];
  for (let el = pane; el; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const name = el.id ? `#${el.id}` : el.tagName.toLowerCase() + (el.hasAttribute('data-chat-scope') ? '[data-chat-scope]' : el === shell ? '(shell)' : '');
    const sides = ['Top', 'Right', 'Bottom', 'Left'];
    const vals = {
      margin: sides.map((k) => px(cs[`margin${k}`])),
      padding: el === pane ? [0, 0, 0, 0] : sides.map((k) => px(cs[`padding${k}`])),
      border: sides.map((k) => (cs[`border${k}Style`] === 'none' ? 0 : px(cs[`border${k}Width`]))),
      radius: ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map((k) => px(cs[`border${k}Radius`])),
    };
    for (const [k, v] of Object.entries(vals)) if (v.some((n) => n !== 0)) bad.push(`${name} ${k} ${v.join(' ')}`);
    if (cs.boxShadow !== 'none') bad.push(`${name} shadow ${cs.boxShadow}`);
  }
  const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  const s = r(shell);
  const p = r(pane);
  const glass = document.querySelector('[data-testid="composer-dock"]');
  const gs = glass && getComputedStyle(glass);
  return {
    vw, vh, shell: s, pane: p, bad,
    gaps: { top: s.t, left: s.l, right: vw - s.r, bottom: vh - s.b, paneLeft: p.l, paneRight: vw - p.r, paneBottom: vh - p.b },
    overflow: { x: document.documentElement.scrollWidth - vw, y: document.documentElement.scrollHeight - vh },
    composer: gs ? { radius: px(gs.borderTopLeftRadius), border: px(gs.borderTopWidth) } : null,
  };
}

/** True when embedEdges() reports a flush page: 0 px at every edge, no box styling on the chain, no overflow, the composer card kept. */
export function embedFlush(e) {
  if (!e || e.error) return false;
  return Object.values(e.gaps).every((g) => g === 0) && e.bad.length === 0 && e.overflow.x <= 0 && e.overflow.y <= 0 &&
    !!e.composer && e.composer.radius > 0 && e.composer.border > 0;
}

let exchangesAfterChecks = null;

export async function tabChecks({ page, frame, api, hostServer, gatewayMock, workspace, shotDir, check, framePort, dataDir, rawRequest, cdnRequests }) {
  const mainKey = slotNameFor(workspace);
  const dash = gatewayMock.rec.dash;
  await clearNotifications(page, frame);

  // 1. (a) The page signed the tunnel in by itself when it opened: a link
  //    minted with the dashboard's own session cookie, no user step.
  const auto = await waitFor(async () => {
    const s = (await api('GET', '/api/session')).json;
    return s && s.kc && s.kc.connected ? s.kc : null;
  }, 20_000);
  // The page's own record of it went with an earlier reload; the stand-in's is kept.
  check('(a) opening the page signs the Kiro Crew tab in automatically with a link minted from the dashboard session (its HttpOnly cookie sent by a plain fetch)',
    !!auto && auto.via === 'auto' && hostServer.mints[0] && hostServer.mints[0].status === 200 && hostServer.mints[0].cookie === true && dash.exchanges >= 1,
    JSON.stringify({ kc: auto && { connected: auto.connected, via: auto.via }, standinMints: hostServer.mints, exchanges: dash.exchanges }));

  // 2. The status bar "Crew" item opens the tab, which frames the tunnelled
  //    /embed/chat for the folder's slot, signed in, with its WebSocket open.
  await frame.locator('.part.auxiliarybar .composite-bar [aria-label^="Chat"]').first().click().catch(() => {});
  await sleep(500);
  await frame.locator('[aria-label="Open the Kiro Crew chat"]').first().click();
  const s1 = await waitFor(() => signedIn(page), 30_000);
  check("the status bar item opens the Kiro Crew tab, framing Kiro Crew's /embed/chat for the folder's slot through the tunnel, signed in with the WebSocket open",
    !!s1 && s1.url.endsWith(`/embed/chat/${mainKey}`) && s1.slot === mainKey, JSON.stringify(s1 || (await embedState(page))));
  const tabs = await auxTabs(frame);
  const docked = await page.locator('[data-testid="vscode-pane-crew"], [data-testid="vscode-pane-crew-sash"]').count();
  check('VS Code\'s secondary side bar shows the "Kiro Crew" tab next to Chat, and the page draws no column or overlay of its own',
    tabs.some((t) => /^Kiro Crew/.test(t.label) && t.active) && tabs.some((t) => /^Chat/.test(t.label)) && docked === 0, `${JSON.stringify(tabs)}; page elements ${docked}`);
  const made = gatewayMock.rec.slots.get(mainKey);
  check('opening the tab created the folder\'s session pointed at the folder, whose name has a space', /\s/.test(path.basename(workspace)) && !!made && String(made.project).toLowerCase() === workspace.toLowerCase(),
    JSON.stringify({ folder: path.basename(workspace), slot: mainKey, project: made && made.project }));

  // 3. The chain is all loopback: the webview comes from the self-hosted
  //    endpoint, nothing from vscode-cdn.net.
  const vf = await waitFor(() => viewFrame(page, framePort), 5000);
  check('the tab\'s webview is served from http://<uuid>.localhost:<frame port>, and no webview loads from vscode-cdn.net',
    !!vf && vf.mode === 'frame' && cdnRequests.length === 0, `${vf && vf.frame.url().replace(/\?.*/, '')}; cdn ${JSON.stringify(cdnRequests.slice(0, 3))}`);

  // 4. The chip: hidden inside the tunnelled chat, another app's kept.
  const ef = embedFrame(page);
  const chips = await ef.evaluate(() => Array.from(document.querySelectorAll('[data-session-control-chip]')).map((b) => ({ id: b.dataset.chipId, display: getComputedStyle(b).display })));
  check('inside the tunnelled chat the app\'s "VS Code" chip is hidden while other apps\' chips show, one with the same Package icon included',
    chips.length === 3 && chips.find((c) => c.id.startsWith('vscode-pane:'))?.display === 'none' && chips.find((c) => c.id.startsWith('other-app:'))?.display !== 'none' && chips.find((c) => c.id.startsWith('package-app:'))?.display !== 'none', JSON.stringify(chips));

  // 4b. The tunnelled chat fills the webview flush (F8): its embed shell
  //     touches all four edges at 0 px, nothing from <html> to the chat pane
  //     keeps a margin, padding, border, radius or shadow, the pane reaches
  //     the left, right and bottom edges, nothing scrolls, and the composer's
  //     own card keeps its border and radius. The webview's own document
  //     (crewview.js) frames it with no margin, border or scrollbar.
  const edges = await ef.evaluate(embedEdges);
  check('the tunnelled chat fills the Kiro Crew webview flush: its outermost card touches all four edges at 0 px with no border, radius or shadow, no gap at the bottom, and the composer keeps its own card',
    embedFlush(edges), JSON.stringify(edges));
  const vfr = await viewFrame(page, framePort);
  const host = vfr && await vfr.frame.evaluate(() => {
    const f = document.getElementById('kc');
    const b = f.getBoundingClientRect();
    const bs = getComputedStyle(document.body);
    const fs = getComputedStyle(f);
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    return { gaps: [b.top, vw - b.right, vh - b.bottom, b.left], bodyMargin: bs.margin, bodyPadding: bs.padding, frameBorder: fs.borderTopWidth + ' ' + fs.borderTopStyle, overflowY: document.documentElement.scrollHeight - vh, overflowX: document.documentElement.scrollWidth - vw };
  }).catch((e) => ({ error: e.message }));
  check('the Kiro Crew webview frames the chat at 0 px from every edge: body margin and padding 0, frame border 0, no scrollbar',
    !!host && !host.error && host.gaps.every((g) => g === 0) && host.bodyMargin === '0px' && host.bodyPadding === '0px' && /^0px/.test(host.frameBorder) && host.overflowY <= 0 && host.overflowX <= 0,
    JSON.stringify(host));

  // 5. The session stays in the launcher.
  const jar = await page.context().cookies();
  const kcCookies = jar.filter((c) => /^mc_(token|refresh)_\d+$/.test(c.name));
  const stateFile = path.join(dataDir, 'state', 'kc-session.json');
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const logText = fs.readFileSync(path.join(dataDir, 'logs', 'launcher.log'), 'utf8');
  let acl = 'n/a';
  let aclOk = true;
  if (process.platform === 'win32') {
    const r = spawnSync('icacls', [stateFile], { encoding: 'utf8', windowsHide: true });
    const aces = String(r.stdout || '').split(/\r?\n/).map((l) => l.replace(stateFile, '').trim()).filter((l) => /:\(/.test(l));
    acl = aces.join(' | ');
    aclOk = aces.length === 1 && /:\(F\)$/.test(aces[0]) && !/\(I\)/.test(acl);
  }
  check('no Kiro Crew session cookie in the browser; the launcher keeps it owner-only in data/state/kc-session.json and never logs it',
    kcCookies.length === 0 && !!saved.token && !!saved.refresh && aclOk && !logText.includes(saved.token) && !logText.includes(saved.refresh),
    `browser mc_* cookies ${kcCookies.length}; acl ${acl}`);

  // 6. Containment, from inside the tunnelled chat and from outside.
  const origin = new URL(ef.url()).origin;
  const kcPort = Number(new URL(origin).port);
  const tried = await ef.evaluate(async () => {
    const out = {};
    for (const p of ['/api/token/local', '/api/auth/mobile-link', '/api/tailnet/qr']) out[p] = (await fetch(p, { method: 'POST' })).status;
    return out;
  });
  const bare = await rawRequest({ port: kcPort, path: '/', headers: { host: `127.0.0.1:${kcPort}` } });
  const foreign = await rawRequest({ port: kcPort, method: 'POST', path: '/api/auth/refresh', headers: { host: new URL(origin).host, origin: 'http://localhost:5476' } });
  check('from the tab, credential-minting routes are refused by the tunnel; a bare Host gets 421 and a foreign Origin 403',
    Object.values(tried).every((v) => v === 403) && dash.forbiddenHits.length === 0 && bare.status === 421 && foreign.status === 403,
    JSON.stringify({ tried, reachedGateway: dash.forbiddenHits, bare: bare.status, foreign: foreign.status }));

  // 7. Ctrl+Alt+K from VS Code opens the tab again.
  await frame.locator('.part.auxiliarybar .composite-bar [aria-label^="Chat"]').first().click().catch(() => {});
  await sleep(500);
  await focusWorkbench(frame);
  await page.keyboard.press('Control+Alt+KeyK');
  const reopened = await waitFor(async () => ((await auxTabs(frame)).find((t) => /^Kiro Crew/.test(t.label) && t.active) ? signedIn(page) : null), 10_000);
  check('Ctrl+Alt+K in VS Code reveals the Kiro Crew tab, still signed in', !!reopened, JSON.stringify(await auxTabs(frame)));

  // 8. Disconnect (the view's title action, here from the palette).
  const logouts0 = dash.logouts;
  await runCommand(page, frame, 'Kiro Crew: Disconnect the Kiro Crew Tab');
  const out = await waitFor(async () => {
    const v = await viewFrame(page, framePort);
    const s = (await api('GET', '/api/session')).json;
    return v && v.mode === 'signin' && s.kc && !s.kc.connected ? { mode: v.mode } : null;
  }, 15_000);
  const pageState = await waitFor(async () => ((await page.locator('[data-testid="vscode-pane-kc-state"]').getAttribute('data-connected')) === 'false' ? 'false' : null), 8000) || 'true';
  check('Disconnect signs the tab out at the gateway, rotates the origin and shows Connect and the paste field',
    !!out && dash.logouts === logouts0 + 1 && !embedFrame(page) && pageState === 'false', JSON.stringify({ out, logouts: dash.logouts - logouts0, page: pageState }));
  check('after Disconnect the old tunnel origin is refused', (await rawRequest({ port: kcPort, path: '/', headers: { host: new URL(origin).host } })).status === 421);

  // V5 S-3: reloading the dashboard does not undo the Disconnect.
  const mintsBefore = hostServer.mints.length;
  await page.reload();
  await frame.locator('.monaco-workbench').waitFor({ timeout: 60_000 }).catch(() => {});
  await sleep(6000);
  const afterReload = (await api('GET', '/api/session')).json.kc;
  check('after Disconnect, a dashboard reload leaves the tab signed out (no automatic sign-in)',
    afterReload.connected === false && afterReload.userDisconnected === true && hostServer.mints.length === mintsBefore,
    JSON.stringify({ connected: afterReload.connected, userDisconnected: afterReload.userDisconnected, mints: hostServer.mints.length - mintsBefore }));
  await frame.locator('[aria-label="Open the Kiro Crew chat"]').first().click().catch(() => {});
  await waitFor(async () => ((await viewFrame(page, framePort)) || {}).mode === 'signin', 30_000);

  // 9. (b) The tab's Connect button: the page mints the link on its next poll.
  await clearNotifications(page, frame);
  await inView(page, framePort, (f) => f.click('#connect', { timeout: 3000 }));
  const viaConnect = await waitFor(() => signedIn(page), 30_000);
  const mints2 = await page.evaluate(() => window.__vscodePane.kcMints);
  check('(b) Connect in the tab signs it in again through the page (a dashboard-minted link), with no paste',
    !!viaConnect && mints2.at(-1).via === 'connect' && mints2.at(-1).ok === true, JSON.stringify({ last: mints2.at(-1), embed: viaConnect }));

  // 10. (c) No dashboard URL in Settings: the mint is refused (409); a pasted
  //     `kirocrew token` link signs the tab in instead.
  await runCommand(page, frame, 'Kiro Crew: Disconnect the Kiro Crew Tab');
  await waitFor(async () => ((await viewFrame(page, framePort)) || {}).mode === 'signin', 15_000);
  hostServer.mobileLink = 'unavailable';
  await clearNotifications(page, frame);
  await inView(page, framePort, (f) => f.click('#connect', { timeout: 3000 }));
  const refused = await waitFor(async () => {
    const v = await viewFrame(page, framePort);
    if (!v || v.mode !== 'signin') return null;
    const txt = await v.frame.evaluate(() => document.body.innerText).catch(() => '');
    return /external_origin_unavailable/.test(txt) ? txt : null;
  }, 20_000);
  check('(b) when the dashboard has no URL configured, Connect reports external_origin_unavailable in the tab and stays signed out', !!refused, String(refused || '').slice(0, 200));
  const setupCmd = await waitFor(async () => page.locator('[data-testid="vscode-pane-kc-setup-command"]').textContent({ timeout: 1000 }).catch(() => null), 8000);
  const pageOrigin = new URL(page.url()).origin;
  check('V5 S-1: the page names the one-time fix, the exact command for this dashboard, and the tab says the same',
    setupCmd === `kirocrew config set dashboard.url ${pageOrigin}` && /kirocrew config set dashboard\.url/.test(String(refused)), `${setupCmd}`);
  const link = gatewayMock.mintLink();
  await inView(page, framePort, async (f) => {
    await f.fill('#link', link, { timeout: 3000 });
    await f.click('#paste', { timeout: 3000 });
  });
  const viaPaste = await waitFor(() => signedIn(page), 30_000);
  const kcNow = (await api('GET', '/api/session')).json.kc;
  check('(c) a pasted sign-in link signs the tab in', !!viaPaste && kcNow.connected && kcNow.via === 'paste', JSON.stringify({ via: kcNow.via, embed: viaPaste }));
  hostServer.mobileLink = 'ok';

  // 11. Built-in webviews still work from the self-hosted endpoint: the Markdown preview.
  const md = path.join(workspace, 'preview me.md');
  fs.writeFileSync(md, '# Preview works through loopback\n\nSome *markdown*.\n');
  await api('POST', '/api/open', { path: md });
  await sleep(1000);
  await runCommand(page, frame, 'Markdown: Open Preview to the Side');
  const preview = await waitFor(async () => {
    for (const f of page.frames()) {
      if (!new RegExp(`^http://[a-z0-9]+\\.localhost:${framePort}/`).test(f.url())) continue;
      const t = await f.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
      if (/Preview works through loopback/.test(t)) return f.url().replace(/\?.*/, '');
    }
    return null;
  }, 30_000);
  check('the Markdown preview renders from the self-hosted webview endpoint, with no webview from vscode-cdn.net', !!preview && cdnRequests.length === 0, `${preview}; cdn ${cdnRequests.length}`);
  // V5 M-1: script in a webview cannot reach the workbench or any file through the frame proxy.
  // The browser-side probe: a webview's own CSP may already stop the fetch.
  // The direct probe below sends the same requests with the webview's real
  // Host, which a webview page with a looser CSP would produce.
  let probed = null;
  let direct = null;
  for (const f of page.frames()) {
    if (!new RegExp(`^http://[a-z0-9]+\\.localhost:${framePort}/vsc-[^/]+/.*/pre/`).test(f.url())) continue;
    if (!direct) {
      const u = new URL(f.url());
      const key = u.pathname.split('/')[1];
      const file = encodeURIComponent(path.join(workspace, 'hello.txt'));
      direct = {
        remoteResource: (await rawRequest({ port: framePort, path: `/${key}/vscode-remote-resource?path=${file}`, headers: { host: u.host } })).status,
        workbench: (await rawRequest({ port: framePort, path: `/${key}/`, headers: { host: u.host } })).status,
        preFile: (await rawRequest({ port: framePort, path: u.pathname, headers: { host: u.host } })).status,
        workbenchHostStillWorks: (await rawRequest({ port: framePort, path: `/${key}/vscode-remote-resource?path=${file}`, headers: { host: `127.0.0.1:${framePort}` } })).status,
      };
    }
    probed = await f.evaluate(async (file) => {
      const key = location.pathname.split('/')[1];
      const out = {};
      for (const [name, url] of [['remoteResource', `/${key}/vscode-remote-resource?path=${encodeURIComponent(file)}`], ['workbench', `/${key}/`], ['preRelative', './../../../../../../../vscode-remote-resource?path=' + encodeURIComponent(file)]]) {
        out[name] = await fetch(url).then((r) => r.status, () => 'blocked');
      }
      return out;
    }, path.join(workspace, 'hello.txt')).catch((e) => ({ error: e.message.slice(0, 80) }));
    if (probed && !probed.error) break;
  }
  check('V5 M-1: a webview origin gets /vscode-remote-resource and the workbench refused (403) while its own pre/ files load and the preview renders',
    !!direct && !!preview && direct.remoteResource === 403 && direct.workbench === 403 && direct.preFile === 200 && direct.workbenchHostStillWorks === 200 &&
      !!probed && Object.values(probed).every((v) => v === 403 || v === 'blocked'),
    JSON.stringify({ direct, inBrowser: probed }));
  // Leave the editors as the later restore checks expect: no preview, hello.txt active.
  for (let i = 0; i < 4; i++) {
    await runCommand(page, frame, 'View: Close All Editors');
    const left = await waitFor(async () => ((await frame.locator('.part.editor .tabs-container .tab').count()) === 0 ? 'none' : null), 4000);
    if (left) break;
  }
  const leftTabs = await frame.locator('.part.editor .tabs-container .tab').count();
  await api('POST', '/api/open', { path: path.join(workspace, 'hello.txt'), line: 2 });
  await sleep(1500);
  check('the preview is closed again (later restore checks expect hello.txt alone)', leftTabs === 0, `${leftTabs} editor tabs left`);

  // 12. Dark screenshot of the tab in VS Code's right pane (mock dashboard behind the tunnel).
  await frame.locator('[aria-label="Open the Kiro Crew chat"]').first().click();
  await waitFor(() => signedIn(page), 10_000);
  await sleep(800);
  const shot = path.join(shotDir, 'crew-tab-dark.png');
  await page.screenshot({ path: shot });
  check('dark screenshot of the Kiro Crew tab (the mock dashboard through the tunnel) saved', fs.existsSync(shot), shot);
  exchangesAfterChecks = dash.exchanges;
}

/** After a launcher restart: still signed in with no new link, and (with a page) the tab still shows the chat. */
export async function tunnelPersists({ api, check, gatewayMock, label, page }) {
  const s = await waitFor(async () => {
    const j = (await api('GET', '/api/session').catch(() => ({ json: null }))).json;
    return j && j.kc && j.kc.available ? j : null;
  }, 30_000);
  let embed = true;
  if (page) {
    await api('POST', '/api/crew/view', { action: 'reveal' });
    embed = await waitFor(() => signedIn(page), 40_000);
  }
  check(`the Kiro Crew tab stays signed in ${label}, with no new sign-in`,
    !!s && s.kc.connected === true && exchangesAfterChecks !== null && gatewayMock.rec.dash.exchanges === exchangesAfterChecks && !!embed,
    JSON.stringify({ connected: s && s.kc.connected, exchanges: [exchangesAfterChecks, gatewayMock.rec.dash.exchanges], embed: !!embed }));
}
