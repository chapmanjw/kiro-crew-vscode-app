// Smoke checks for the Kiro Crew tab in VS Code's secondary side bar: the
// bridge's webview view, the view-overlay script the frame proxy injects
// (backend/lib/view-overlay.js), and the ChatPanel the page draws over the
// view (ui/vscode-pane-crew-*.mjs). Run by scripts/smoke.mjs against the
// dashboard stand-in, whose SDK shim has a ChatPanel stub that records its props.
import fs from 'node:fs';
import path from 'node:path';
import { slotNameFor } from '../../backend/lib/gateway.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 10_000, step = 200) {
  const t = Date.now();
  let v;
  while (Date.now() - t < ms) {
    v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return v;
}

const WEBVIEW = 'iframe.webview[src*="extensionId=kiro-crew.kiro-crew-bridge"][src*="purpose=webviewView"]';

/** The overlay's state and box in the page. */
function overlay(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="vscode-pane-crew"]');
    const hd = window.__vscodePane;
    if (!el) return { present: false, rejected: hd.viewRejected, accepted: hd.viewAccepted };
    const r = el.getBoundingClientRect();
    const stub = el.querySelector('[data-testid="crew-chatpanel-stub"]');
    const active = document.activeElement;
    return {
      present: true,
      visible: el.dataset.visible === 'true' && getComputedStyle(el).visibility === 'visible',
      reason: el.dataset.hiddenReason || '',
      location: el.dataset.location || '',
      box: { x: r.left, y: r.top, width: r.width, height: r.height },
      stubSlot: stub ? stub.dataset.slot : null,
      stubConversationOnly: stub ? stub.dataset.conversationOnly : null,
      focusInside: !!active && el.contains(active),
      focusTag: active ? active.tagName.toLowerCase() : '',
      rejected: hd.viewRejected,
      accepted: hd.viewAccepted,
      keys: hd.keysForwarded,
      chatPanel: window.__standinSdk && { ...window.__standinSdk.chatPanel, props: window.__standinSdk.chatPanel.props.slice(-3) },
    };
  });
}

/** Overlay box against the webview's own box (Playwright's page coordinates), within 1px. */
async function matchView(page, frame) {
  const o = await overlay(page);
  const w = await frame.locator(WEBVIEW).first().boundingBox().catch(() => null);
  const d = o.present && o.box && w ? [o.box.x - w.x, o.box.y - w.y, o.box.width - w.width, o.box.height - w.height].map((n) => Math.round(n * 100) / 100) : null;
  return { ok: !!d && o.visible && d.every((n) => Math.abs(n) <= 1), d, o, w: w && [w.x, w.y, w.width, w.height].map((n) => Math.round(n)) };
}

async function waitMatch(page, frame, ms = 8000) {
  let m;
  const t = Date.now();
  while (Date.now() - t < ms) {
    m = await matchView(page, frame);
    if (m.ok) {
      // Stable for two more polls (a layout that is still moving is not a match).
      await sleep(250);
      const again = await matchView(page, frame);
      if (again.ok) return again;
      m = again;
    }
    await sleep(200);
  }
  return m;
}

const show = (m) => JSON.stringify({ d: m && m.d, webview: m && m.w, visible: m && m.o && m.o.visible, reason: m && m.o && m.o.reason });

async function focusWorkbench(frame) {
  await frame.locator('.monaco-workbench .part.editor').first().click({ position: { x: 200, y: 160 } }).catch(() => {});
}

/** Run a VS Code command by its palette title. */
async function runCommand(page, frame, title) {
  await focusWorkbench(frame);
  await page.keyboard.press('Control+Shift+KeyP');
  await frame.locator('.quick-input-widget input').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await page.keyboard.type(title, { delay: 5 });
  await sleep(500);
  await page.keyboard.press('Enter');
  await sleep(300);
}

/** Toasts left by earlier steps sit bottom right, over the view, and rightly hide the overlay. */
async function clearNotifications(page, frame) {
  if ((await frame.locator('.notifications-toasts.visible .notification-toast-container').count().catch(() => 0)) === 0) return 0;
  await runCommand(page, frame, 'Notifications: Clear All Notifications');
  await waitFor(async () => (await frame.locator('.notifications-toasts.visible .notification-toast-container').count().catch(() => 0)) === 0, 5000);
  return 1;
}

async function auxTab(frame, label) {
  return frame.locator(`.part.auxiliarybar .composite-bar [aria-label^="${label}"]`).first();
}

export async function tabChecks({ page, frame, api, hostServer, gatewayMock, workspace, shotDir, check, framePort }) {
  const mainKey = slotNameFor(workspace);
  const sideKey = `vscode-chat-${mainKey.slice(-6)}-2`;
  hostServer.crewSlots.push(
    { key: mainKey, title: `VS Code: ${path.basename(workspace)}`, project: workspace, messages: 3, running: false, last_ts: '2026-11-15T09:00:00Z' },
    { key: sideKey, title: 'VS Code chat: second session', project: workspace, messages: 1, running: true, last_ts: '2026-11-15T10:00:00Z' },
    { key: 'elsewhere-1', title: 'Some other project', project: path.join(path.dirname(workspace), 'elsewhere'), messages: 1, running: false },
  );

  const cleared = await clearNotifications(page, frame);
  if (cleared) console.log('tab checks: cleared notification toasts left by earlier steps');
  // 1. With Chat showing, the overlay is hidden; the status bar "Crew" item opens the tab.
  await (await auxTab(frame, 'Chat')).click().catch(() => {});
  const hiddenWithChat = await waitFor(async () => {
    const o = await overlay(page);
    return o.present && !o.visible ? o : null;
  }, 8000);
  check('while VS Code\'s Chat tab shows, the overlay is hidden (the view is not visible)', !!hiddenWithChat, JSON.stringify(hiddenWithChat || (await overlay(page))));
  await frame.locator('[aria-label="Open the Kiro Crew chat"]').first().click();
  let m = await waitMatch(page, frame);
  // 2. The tab sits in VS Code's secondary side bar next to Chat (the active
  //    tab always shows; others can fold into "Additional Views" when narrow).
  const tabs = await frame.locator('.part.auxiliarybar .composite-bar .action-item').evaluateAll((els) => els.map((e) => ({
    label: (e.querySelector('.action-label') || e).getAttribute('aria-label') || '',
    active: e.classList.contains('checked') || !!e.querySelector('.action-label.checked'),
  })));
  const docked = await page.locator('[data-testid="vscode-pane-crew-sash"]').count();
  check('VS Code\'s secondary side bar shows a "Kiro Crew" tab next to Chat, and the page has no docked column or sash',
    tabs.some((t) => /^Kiro Crew/.test(t.label) && t.active) && tabs.some((t) => /^Chat/.test(t.label)) && docked === 0, `${JSON.stringify(tabs)}; sash ${docked}`);
  check('the status bar "Crew" item opens the Kiro Crew tab and the overlay lands on the view within 1px', m.ok && m.o.location === 'auxiliarybar', show(m));
  const o1 = await waitFor(async () => {
    const o = await overlay(page);
    return o.stubSlot ? o : null;
  }, 8000) || (await overlay(page));
  check('the overlay mounts ChatPanel on the folder\'s main slot with conversationOnly', o1.stubSlot === mainKey && o1.stubConversationOnly === 'true' &&
    o1.chatPanel && o1.chatPanel.props.some((p) => p.slotKey === mainKey && p.conversationOnly === true), `${o1.stubSlot} want ${mainKey}; ${JSON.stringify(o1.chatPanel && o1.chatPanel.props)}`);

  // 3. Ctrl+Alt+K in VS Code opens the tab and moves the keyboard into the chat.
  await (await auxTab(frame, 'Chat')).click().catch(() => {});
  await waitFor(async () => !(await overlay(page)).visible, 5000);
  await focusWorkbench(frame);
  await page.keyboard.press('Control+Alt+KeyK');
  const focused = await waitFor(async () => {
    const o = await overlay(page);
    return o.visible && o.focusInside ? o : null;
  }, 8000);
  check('Ctrl+Alt+K in VS Code opens the Kiro Crew tab and the keyboard lands in the chat composer drawn over it',
    !!focused && focused.focusTag === 'textarea', JSON.stringify(focused || (await overlay(page))));

  // 4. The overlay follows the view: a dashboard layout change, a side-bar width drag, a window resize.
  await page.evaluate(() => {
    document.getElementById('shell').style.gridTemplateColumns = '200px minmax(0,1fr)';
  });
  m = await waitMatch(page, frame);
  check('after the dashboard layout narrows the pane, the overlay still matches the view within 1px', m.ok, show(m));
  await page.evaluate(() => {
    document.getElementById('shell').style.gridTemplateColumns = '';
  });
  m = await waitMatch(page, frame);
  const aux0 = await frame.locator('.part.auxiliarybar').first().boundingBox();
  const sy = Math.round(aux0.y + aux0.height / 2);
  // VS Code's sash takes a press only after the pointer has hovered it.
  const sx = Math.round(aux0.x) - 1;
  await page.mouse.move(sx, sy);
  await sleep(300);
  await page.mouse.down();
  await sleep(100);
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(sx - i * 30, sy, { steps: 3 });
    await sleep(30);
  }
  await page.mouse.up();
  await sleep(500);
  const aux1 = await frame.locator('.part.auxiliarybar').first().boundingBox();
  m = await waitMatch(page, frame);
  check('dragging the secondary side bar\'s sash 300px left widens the view and the overlay matches it within 1px',
    aux1.width - aux0.width >= 250 && m.ok, `side bar ${Math.round(aux0.width)} -> ${Math.round(aux1.width)}px; ${show(m)}`);
  await page.setViewportSize({ width: 1220, height: 780 });
  m = await waitMatch(page, frame);
  check('after a window resize the overlay matches the view within 1px', m.ok, show(m));
  await page.setViewportSize({ width: 1400, height: 900 });
  m = await waitMatch(page, frame);

  // 5. Idle, the frame script measures on change only (no 60 Hz loop).
  const wbFrame = page.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${framePort}/vsc-`));
  const meas0 = await wbFrame.evaluate(() => window.__kcViewOverlay.measures);
  await sleep(3000);
  const meas1 = await wbFrame.evaluate(() => window.__kcViewOverlay.measures);
  check('idle for 3 s the workbench script measures the view only on change (not every frame)', meas1 - meas0 <= 60, `${meas1 - meas0} measurements in 3 s`);

  // 6. VS Code's popups over the view hide the overlay: the command palette,
  //    a notification toast, and the palette opened by F1 from inside the chat.
  await clearNotifications(page, frame);
  await focusWorkbench(frame);
  await page.keyboard.press('Control+Shift+KeyP');
  const qi = await frame.locator('.quick-input-widget').first().boundingBox().catch(() => null);
  const ob = (await overlay(page)).box;
  const hiddenQi = await waitFor(async () => {
    const o = await overlay(page);
    return !o.visible && /quickInput/.test(o.reason) ? o : null;
  }, 5000);
  const crosses = !!qi && !!ob && qi.x < ob.x + ob.width && ob.x < qi.x + qi.width && qi.y < ob.y + ob.height && ob.y < qi.y + qi.height;
  check('the command palette opened over the view hides the overlay', crosses && !!hiddenQi, `palette ${JSON.stringify(qi && [qi.x, qi.y, qi.width, qi.height].map(Math.round))} crosses overlay ${crosses}; ${JSON.stringify(hiddenQi || (await overlay(page)))}`);
  // Run "Show Bridge Status": its notification toast sits bottom right, over the view.
  await page.keyboard.type('Kiro Crew: Show Bridge Status', { delay: 5 });
  await sleep(400);
  await page.keyboard.press('Enter');
  const toastHidden = await waitFor(async () => {
    const o = await overlay(page);
    return !o.visible && /notification/.test(o.reason) ? o : null;
  }, 8000);
  check('a VS Code notification toast over the view hides the overlay', !!toastHidden, JSON.stringify(toastHidden || (await overlay(page))));
  await clearNotifications(page, frame);
  await focusWorkbench(frame);
  await page.keyboard.press('Escape');
  m = await waitMatch(page, frame);
  check('when the palette and toast close, the overlay shows again on the view', m.ok, show(m));
  await page.locator('[data-testid="vscode-pane-crew"] textarea').first().click();
  const keys0 = (await overlay(page)).keys;
  await page.keyboard.press('F1');
  const f1 = await waitFor(async () => {
    const o = await overlay(page);
    const open = await frame.locator('.quick-input-widget').first().isVisible().catch(() => false);
    return open && !o.visible && o.keys > keys0 ? o : null;
  }, 6000);
  check('F1 pressed in the chat goes to VS Code: the command palette opens and the overlay steps aside', !!f1, JSON.stringify(f1 || (await overlay(page))));
  await page.keyboard.press('Escape');
  m = await waitMatch(page, frame);
  check('Escape closes the palette (keyboard was handed to VS Code) and the overlay returns', m.ok, show(m));

  // 7. The view collapsing: the secondary side bar closed hides the overlay; reopened, it returns.
  await focusWorkbench(frame);
  await page.keyboard.press('Control+Alt+KeyB');
  const collapsed = await waitFor(async () => {
    const o = await overlay(page);
    return !o.visible && /view/.test(o.reason) ? o : null;
  }, 6000);
  await page.keyboard.press('Control+Alt+KeyB');
  m = await waitMatch(page, frame);
  check('closing the secondary side bar hides the overlay, reopening it shows the overlay on the view again', !!collapsed && m.ok, `${JSON.stringify(collapsed)}; ${show(m)}`);

  // 8. Messages that are not the frame's own are ignored: the page's own
  //    window, a wrong nonce from the frame, the right nonce from another
  //    window on the frame's origin.
  const rej0 = (await overlay(page)).rejected;
  const fake = (nonce) => ({ type: 'kc-view', nonce, seq: 1e9, view: { found: true, visible: false, rect: null, location: 'none', focused: false }, blocked: [], dragging: false, viewport: { w: 100, h: 100 }, hidden: false });
  const nonce = await page.evaluate(() => window.__vscodePane.viewNonce);
  await page.evaluate((msg) => window.postMessage(msg, '*'), fake(nonce));
  await wbFrame.evaluate((msg) => window.parent.postMessage(msg, '*'), fake('0'.repeat(32)));
  await page.evaluate((src) => new Promise((ok) => {
    const f = document.createElement('iframe');
    f.id = 'smoke-foreign-frame';
    f.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px;opacity:0';
    f.onload = ok;
    f.src = src;
    document.body.appendChild(f);
  }), `http://127.0.0.1:${framePort}/not-the-workbench`);
  const foreign = page.frames().find((f) => f.url().endsWith('/not-the-workbench'));
  if (foreign) await foreign.evaluate((msg) => window.parent.postMessage(msg, '*'), fake(nonce)).catch(() => {});
  await sleep(800);
  const after = await overlay(page);
  m = await matchView(page, frame);
  check('postMessages from the page itself, with a wrong nonce, or from another window on the frame origin are ignored',
    after.rejected - rej0 === 3 && m.ok, `rejected +${after.rejected - rej0}; overlay ${show(m)}`);
  await page.evaluate(() => document.getElementById('smoke-foreign-frame')?.remove());

  // 9. The chip: hidden inside the embedded chat, the other app's chip kept.
  const chips = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="vscode-pane-crew"] [data-session-control-chip]'))
    .map((b) => ({ id: b.dataset.chipId, display: getComputedStyle(b).display })));
  check('inside the embedded ChatPanel the app\'s "VS Code" chip is hidden and another app\'s chip still shows',
    chips.length === 2 && chips.find((c) => c.id.startsWith('vscode-pane:'))?.display === 'none' && chips.find((c) => c.id.startsWith('other-app:'))?.display !== 'none', JSON.stringify(chips));

  // 10. The view moved to the primary side bar and back: the overlay follows.
  const mv = await api('POST', '/api/crew/view', { action: 'move', to: 'sidebar' });
  m = await waitMatch(page, frame, 10_000);
  check('moved to the primary side bar, the overlay follows the view within 1px', mv.json && mv.json.ok && m.ok && m.o.location === 'sidebar', `${JSON.stringify(mv.json)}; ${show(m)} at ${m.o && m.o.location}`);
  const back = await api('POST', '/api/crew/view', { action: 'move', to: 'auxiliarybar' });
  m = await waitMatch(page, frame, 10_000);
  check('moved back to the secondary side bar, the overlay is on the view again', back.json && back.json.ok && m.ok && m.o.location === 'auxiliarybar', `${show(m)} at ${m.o && m.o.location}`);
  const badMove = await api('POST', '/api/crew/view', { action: 'move', to: 'window' });
  check('POST /api/crew/view refuses an unknown destination', badMove.status === 400, String(badMove.status));

  // 11. The session switcher and "Open in Kiro Crew" in the slim header.
  await page.click('[data-testid="vscode-pane-crew-switcher"]');
  const listed = await waitFor(async () => {
    const keys = await page.$$eval('[data-testid="vscode-pane-crew-menu"] [role="option"]', (els) => els.map((e) => e.dataset.slot));
    return keys.length >= 2 ? keys : null;
  }, 5000);
  check('the header\'s session switcher lists this folder\'s sessions (main first) and not other projects',
    listed && listed[0] === mainKey && listed.includes(sideKey) && !listed.includes('elsewhere-1'), JSON.stringify(listed));
  await page.click(`[data-testid="vscode-pane-crew-menu"] [data-slot="${sideKey}"]`);
  const switched = await waitFor(async () => (await overlay(page)).stubSlot === sideKey, 5000);
  check('picking a session rebinds the overlay\'s ChatPanel to it', !!switched, String((await overlay(page)).stubSlot));
  await page.click('[data-testid="vscode-pane-crew-switcher"]');
  await page.click(`[data-testid="vscode-pane-crew-menu"] [data-slot="${mainKey}"]`);
  await waitFor(async () => (await overlay(page)).stubSlot === mainKey, 5000);

  // 12. Tabbing away unmounts the chat with the page; the /chat view keeps the
  //     chip; coming back puts the overlay on the view again.
  const mounts0 = (await overlay(page)).chatPanel.mounts;
  await page.click('#nav-chat');
  await page.locator('[data-testid="composer-context-shelf"]').waitFor({ timeout: 5000 });
  const away = await page.evaluate(() => ({
    overlay: !!document.querySelector('[data-testid="vscode-pane-crew"]'),
    live: window.__standinSdk.chatPanel.live,
    chip: (() => {
      const b = document.querySelector('[data-testid="composer-context-shelf"] [data-chip-id^="vscode-pane:"]');
      return b ? getComputedStyle(b).display : 'missing';
    })(),
    style: !!document.getElementById('vscode-pane-crew-style-0-5-0'),
  }));
  check('on a normal Kiro Crew session the "VS Code" chip still shows (the hiding rule is scoped to the overlay)', away.chip !== 'none' && away.chip !== 'missing' && away.style, JSON.stringify(away));
  await page.click('#nav-vscode');
  m = await waitMatch(page, frame, 10_000);
  const o2 = await overlay(page);
  check('tabbing away unmounts the overlay\'s ChatPanel; coming back remounts it on the same session over the view',
    !away.overlay && away.live === 0 && o2.chatPanel.mounts === mounts0 + 1 && o2.stubSlot === mainKey && m.ok, JSON.stringify({ away, mounts: `${mounts0} -> ${o2.chatPanel.mounts}`, slot: o2.stubSlot, m: show(m) }));

  // 13. A host without ChatPanel shows "Open in Kiro Crew" instead.
  await page.evaluate(() => window.__standinSdk.setChatPanel(false));
  await page.click('#nav-chat');
  await page.click('#nav-vscode');
  const fb = await waitFor(async () => (await page.locator('[data-testid="vscode-pane-crew-fallback"]').count()) > 0, 8000);
  check('without ChatPanel the overlay shows the "Open in Kiro Crew" fallback', !!fb);
  await page.locator('[data-testid="vscode-pane-crew-fallback"] button').click().catch(() => {});
  const landed = await waitFor(() => page.evaluate(() => (location.pathname.startsWith('/chat/') ? location.pathname : '')), 5000);
  check('"Open in Kiro Crew" goes to the session on the Chat page', landed === `/chat/${encodeURIComponent(mainKey)}`, landed);
  await page.evaluate(() => window.__standinSdk.setChatPanel(true));
  await page.click('#nav-vscode');
  await waitMatch(page, frame, 10_000);

  // 14. The launcher names the folder's slot and created it in Kiro Crew.
  const raw = await page.evaluate((f) => fetch(`/apps/vscode-pane/api/session?folder=${encodeURIComponent(f)}`).then((r) => r.json()), workspace);
  const made = gatewayMock && gatewayMock.rec.slots.get(mainKey);
  check("the launcher reports the folder's crew slot and the view's state, and has created the slot in Kiro Crew pointed at the folder",
    !!raw && raw.crewSlot && raw.crewSlot.key === mainKey && raw.crewView && raw.crewView.resolved === true && raw.crewView.visible === true &&
      !!made && String(made.project).toLowerCase() === workspace.toLowerCase(),
    JSON.stringify({ crewSlot: raw && raw.crewSlot, crewView: raw && raw.crewView }));

  // 15. Dark screenshot of the tab in VS Code's right pane.
  await (await auxTab(frame, 'Kiro Crew')).click().catch(() => {});
  m = await waitMatch(page, frame);
  await sleep(600);
  const shot = path.join(shotDir, 'crew-tab-dark.png');
  await page.screenshot({ path: shot });
  check('dark screenshot of the Kiro Crew tab in VS Code\'s right pane saved', fs.existsSync(shot) && m.ok, shot);
}
