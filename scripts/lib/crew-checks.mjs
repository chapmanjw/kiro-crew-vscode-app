// Smoke checks for the docked Kiro Crew chat column (ui/vscode-pane-crew-*.mjs),
// run by scripts/smoke.mjs against the dashboard stand-in, whose SDK shim
// provides a ChatPanel stub that records its props.
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

/** Column, frame host, frame slot and card geometry, plus whether the frame matches its slot within 1px. */
function geometry(page) {
  return page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect() : null;
    };
    const host = document.querySelector('div[data-vscode-pane-frame-host]');
    const hr = host && host.getBoundingClientRect();
    const slot = r('[data-testid="vscode-pane-frame-slot"]');
    const col = r('[data-testid="vscode-pane-crew"]');
    const card = r('[data-testid="vscode-pane-card"]');
    const head = r('[data-testid="vscode-pane-crew-header"]');
    const bar = r('[role="toolbar"]');
    const d = hr && slot ? [hr.left - slot.left, hr.top - slot.top, hr.width - slot.width, hr.height - slot.height].map((n) => Math.round(n * 10) / 10) : null;
    const stub = document.querySelector('[data-testid="crew-chatpanel-stub"]');
    return {
      frameOk: !!d && d.every((n) => Math.abs(n) <= 1) && host.dataset.visible === 'true',
      d,
      clip: host ? host.style.clipPath : '',
      frameRight: hr ? Math.round(hr.right) : null,
      slot: slot && [slot.left, slot.top, slot.width, slot.height].map(Math.round),
      col: col && { left: Math.round(col.left), right: Math.round(col.right), top: Math.round(col.top), bottom: Math.round(col.bottom), width: Math.round(col.width) },
      card: card && { left: Math.round(card.left), right: Math.round(card.right), bottom: Math.round(card.bottom), width: Math.round(card.width) },
      head: head ? Math.round(head.height) : null,
      barBottom: bar ? Math.round(bar.bottom) : null,
      stubSlot: stub ? stub.dataset.slot : null,
      stubConversationOnly: stub ? stub.dataset.conversationOnly : null,
      fallback: !!document.querySelector('[data-testid="vscode-pane-crew-fallback"]'),
      chatPanel: window.__standinSdk && { ...window.__standinSdk.chatPanel, props: window.__standinSdk.chatPanel.props.slice(-3) },
      stored: { open: localStorage.getItem('kc:vscode-pane:crew-open'), width: localStorage.getItem('kc:vscode-pane:crew-width') },
      toggles: window.__vscodePane.crewToggles,
    };
  });
}

/** What is painted at a point: the column, the VS Code frame host, a body-level menu, or something else. */
function hitAt(page, x, y) {
  return page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    if (!el) return 'none';
    if (el.closest('[data-testid="stub-picker-menu"]')) return 'menu';
    if (el.closest('[data-testid="vscode-pane-crew"]')) return 'column';
    if (el.closest('div[data-vscode-pane-frame-host]')) return 'frame';
    return el.tagName.toLowerCase();
  }, [x, y]);
}

export async function crewChecks({ page, frame, hostServer, workspace, shotDir, check }) {
  const mainKey = slotNameFor(workspace);
  // Two more sessions for the switcher: a per-chat slot on this folder (like
  // the native-chat sessions the bridge opens) and one on another project.
  const sideKey = `vscode-chat-${mainKey.slice(-6)}-2`;
  hostServer.crewSlots.push(
    { key: mainKey, title: `VS Code: ${path.basename(workspace)}`, project: workspace, messages: 3, running: false, last_ts: '2026-11-15T09:00:00Z' },
    { key: sideKey, title: 'VS Code chat: second session', project: workspace, messages: 1, running: true, last_ts: '2026-11-15T10:00:00Z' },
    { key: 'elsewhere-1', title: 'Some other project', project: path.join(path.dirname(workspace), 'elsewhere'), messages: 1, running: false },
  );

  // 1. The column mounts on the folder's main slot, docked flush right.
  await page.locator('[data-testid="crew-chatpanel-stub"]').waitFor({ timeout: 15_000 }).catch(() => {});
  await sleep(600);
  let g = await geometry(page);
  check('crew column mounts ChatPanel on the folder\'s main slot with conversationOnly', g.stubSlot === mainKey && g.stubConversationOnly === 'true' &&
    g.chatPanel && g.chatPanel.props.some((p) => p.slotKey === mainKey && p.conversationOnly === true), `${g.stubSlot} want ${mainKey}; ${JSON.stringify(g.chatPanel && g.chatPanel.props)}`);
  check('crew column is docked flush right in the card under the toolbar, 35px header, default 420px',
    g.col && g.card && Math.abs(g.col.right - (g.card.right - 1)) <= 1 && Math.abs(g.col.bottom - (g.card.bottom - 1)) <= 1 && Math.abs(g.col.top - g.barBottom) <= 1 && g.head === 35 && g.col.width === 420,
    JSON.stringify({ col: g.col, card: g.card, bar: g.barBottom, head: g.head }));
  check('the VS Code frame shrinks to the narrower slot and stops at the sash', g.frameOk && g.frameRight <= g.col.left - 3, JSON.stringify({ d: g.d, frameRight: g.frameRight, colLeft: g.col && g.col.left }));
  check('with the column open the frame clips only its bottom-left corner', /round 0px 0px 0px 15px/.test(g.clip), g.clip);
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="vscode-pane-crew"]')).backgroundColor);
  check('crew column paints from the dashboard theme variables (--bg)', bg === 'rgb(33, 34, 44)', bg);

  // 2. The frame overlay does not cover the column, and the column's popovers are not clipped.
  const cx = Math.round((g.col.left + g.col.right) / 2);
  const hits = [await hitAt(page, cx, g.col.top + 18), await hitAt(page, cx, Math.round((g.col.top + g.col.bottom) / 2)), await hitAt(page, g.col.left + 3, g.col.bottom - 30)];
  check('the VS Code frame overlay covers no part of the column (header, transcript, composer)', hits.every((x) => x === 'column'), hits.join(', '));
  await page.click('[data-testid="stub-picker"]');
  const menuBox = await waitFor(() => page.evaluate(() => {
    const m = document.querySelector('[data-testid="stub-picker-menu"]');
    return m && m.getBoundingClientRect().toJSON();
  }), 5000);
  let menuHits = [];
  if (menuBox) {
    const pts = [[menuBox.left + 4, menuBox.top + 4], [menuBox.right - 4, menuBox.top + 4], [menuBox.left + 4, menuBox.bottom - 4], [menuBox.right - 4, menuBox.bottom - 4]];
    for (const [x, y] of pts) menuHits.push(await hitAt(page, Math.round(x), Math.round(y)));
  }
  check('a composer picker menu from the column is drawn whole, above the frame and the column', menuBox && menuHits.every((x) => x === 'menu'), `${menuHits.join(', ')} ${JSON.stringify(menuBox && { l: Math.round(menuBox.left), t: Math.round(menuBox.top) })}`);
  await page.click('[data-testid="stub-picker"]');
  await page.click('[data-testid="vscode-pane-crew-switcher"]');
  const menu = page.locator('[data-testid="vscode-pane-crew-menu"]');
  await menu.waitFor({ timeout: 5000 }).catch(() => {});
  const listed = await waitFor(async () => {
    const keys = await page.$$eval('[data-testid="vscode-pane-crew-menu"] [role="option"]', (els) => els.map((e) => e.dataset.slot));
    return keys.length >= 2 ? keys : null;
  }, 5000);
  const swHits = [];
  const swBox = await menu.boundingBox().catch(() => null);
  if (swBox) for (const [x, y] of [[swBox.x + 4, swBox.y + 4], [swBox.x + swBox.width - 4, swBox.y + swBox.height - 4]]) swHits.push(await hitAt(page, Math.round(x), Math.round(y)));
  check('the session switcher lists this folder\'s sessions (main first, the per-chat slot too) and not other projects',
    listed && listed[0] === mainKey && listed.includes(sideKey) && !listed.includes('elsewhere-1'), JSON.stringify(listed));
  check('the session switcher menu is drawn whole inside the column', swHits.length === 2 && swHits.every((x) => x === 'column'), swHits.join(', '));
  await page.click(`[data-testid="vscode-pane-crew-menu"] [data-slot="${sideKey}"]`);
  const switched = await waitFor(async () => (await geometry(page)).stubSlot === sideKey, 5000);
  const title = await page.locator('[data-testid="vscode-pane-crew-switcher"]').textContent();
  check('picking a session from the switcher rebinds ChatPanel to it and shows its title', switched && /second session/.test(title), title);
  await page.click('[data-testid="vscode-pane-crew-switcher"]');
  await page.click(`[data-testid="vscode-pane-crew-menu"] [data-slot="${mainKey}"]`);
  await waitFor(async () => (await geometry(page)).stubSlot === mainKey, 5000);

  // 3. The sash resizes the column, the width is remembered, and the frame follows.
  const sash = await page.locator('[data-testid="vscode-pane-crew-sash"]').boundingBox();
  const colRight = g.col.right;
  const x0 = Math.round(sash.x + sash.width / 2);
  const y0 = Math.round(sash.y + 200);
  const pressHit = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    window.__crewSashEvents = 0;
    document.addEventListener('pointermove', () => { window.__crewSashEvents++; }, true);
    return el ? `${el.tagName.toLowerCase()}.${el.className}` : 'none';
  }, [x0, y0]);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(x0 - i * 12, y0, { steps: 2 });
  await page.mouse.up();
  await sleep(500);
  g = await geometry(page);
  const dragged = colRight - (x0 - 120);
  const moves = await page.evaluate(() => window.__crewSashEvents);
  const shieldLeft = await page.evaluate(() => !!document.querySelector('[data-vscode-pane-drag-shield]'));
  check('dragging the sash 120px left across the VS Code frame widens the column by 120px, stores the width and removes the drag shield', Math.abs(g.col.width - dragged) <= 1 && g.stored.width === String(g.col.width) && !shieldLeft,
    `${g.col.width}px want ${dragged}, stored ${g.stored.width}; pressed on ${pressHit}, ${moves} pointermoves in the page, drag shield left behind ${shieldLeft}`);
  check('after the drag the VS Code frame matches its narrower slot', g.frameOk && g.frameRight <= g.col.left - 3, JSON.stringify({ d: g.d, slot: g.slot }));
  const beforeKey = g.col.width;
  await page.locator('[data-testid="vscode-pane-crew-sash"]').focus();
  await page.keyboard.press('ArrowRight');
  await sleep(300);
  g = await geometry(page);
  const kept = beforeKey - 16;
  check('the sash is keyboard-resizable (ArrowRight narrows by 16px)', g.col.width === kept && g.stored.width === String(kept), `${beforeKey} -> ${g.col.width}px`);

  // 4. The toolbar button toggles the column; VS Code gets the whole card back.
  await page.click('[data-testid="vscode-pane-crew-toggle"]');
  await sleep(500);
  g = await geometry(page);
  check('the toolbar "Kiro Crew" button hides the column and the frame fills the card', !g.col && g.frameOk && Math.abs(g.slot[2] - (g.card.width - 2)) <= 1 && /round 0px 0px 15px 15px/.test(g.clip) && g.stored.open === '0',
    JSON.stringify({ slot: g.slot, card: g.card, clip: g.clip, stored: g.stored }));
  await page.click('[data-testid="vscode-pane-crew-toggle"]');
  await sleep(500);
  g = await geometry(page);
  check('the button shows it again at the remembered width on the same session', g.col && g.col.width === kept && g.stubSlot === mainKey && g.frameOk && g.stored.open === '1', JSON.stringify({ col: g.col, slot: g.stubSlot }));

  // 5. VS Code's toggle command reaches the page through crewChatToggle.
  const toggles0 = g.toggles;
  hostServer.crewToggle += 1;
  const hidden = await waitFor(async () => !(await geometry(page)).col, 8000);
  hostServer.crewToggle += 1;
  const shown = await waitFor(async () => !!(await geometry(page)).col, 8000);
  g = await geometry(page);
  check('a crewChatToggle bump (VS Code Ctrl+Alt+K) hides the column, the next shows it, within a session poll', hidden && shown && g.toggles === toggles0 + 2 && g.frameOk, `hidden ${!!hidden}, shown ${!!shown}, toggles ${toggles0} -> ${g.toggles}`);
  hostServer.crewToggle += 2;
  await sleep(3500);
  g = await geometry(page);
  check('two presses between polls cancel out', !!g.col && g.toggles === toggles0 + 2, `toggles ${g.toggles}`);

  // 6. Leaving the page and coming back keeps the column, its width and session, and the frame alignment.
  const mounts0 = g.chatPanel.mounts;
  await page.click('#nav-chat');
  await page.locator('[data-testid="composer-context-shelf"]').waitFor({ timeout: 5000 });
  const away = await page.evaluate(() => ({ col: !!document.querySelector('[data-testid="vscode-pane-crew"]'), live: window.__standinSdk.chatPanel.live }));
  await sleep(2500);
  await page.click('#nav-vscode');
  await page.locator('[data-testid="crew-chatpanel-stub"]').waitFor({ timeout: 10_000 }).catch(() => {});
  await sleep(1200);
  g = await geometry(page);
  check('tabbing away unmounts ChatPanel with the page and coming back remounts it on the same session',
    !away.col && away.live === 0 && g.chatPanel.mounts === mounts0 + 1 && g.stubSlot === mainKey, JSON.stringify({ away, mounts: `${mounts0} -> ${g.chatPanel.mounts}`, slot: g.stubSlot }));
  check('after tabbing back the column keeps its width and the VS Code frame is aligned to the narrower slot', g.col && g.col.width === kept && g.frameOk, JSON.stringify({ col: g.col, d: g.d }));
  check('tabbing back does not replay old toggle presses', g.toggles === toggles0 + 2, String(g.toggles));
  await page.click('[data-testid="vscode-pane-crew-collapse"]');
  await page.click('#nav-chat');
  await page.locator('[data-testid="composer-context-shelf"]').waitFor({ timeout: 5000 });
  await page.click('#nav-vscode');
  await page.locator('[data-testid="vscode-pane-card"]').waitFor({ timeout: 5000 });
  await sleep(1200);
  g = await geometry(page);
  check('a column hidden with its collapse button stays hidden across tabbing away and back', !g.col && g.frameOk, JSON.stringify({ col: g.col, d: g.d }));
  await page.click('[data-testid="vscode-pane-crew-toggle"]');
  await page.locator('[data-testid="crew-chatpanel-stub"]').waitFor({ timeout: 5000 }).catch(() => {});

  // 7. A host without ChatPanel gets "Open in Kiro Crew" instead.
  await page.evaluate(() => window.__standinSdk.setChatPanel(false));
  await page.click('[data-testid="vscode-pane-crew-toggle"]');
  await page.click('[data-testid="vscode-pane-crew-toggle"]');
  await sleep(500);
  g = await geometry(page);
  const fbButton = page.locator('[data-testid="vscode-pane-crew-fallback"] button');
  check('without ChatPanel the column shows the "Open in Kiro Crew" fallback', g.fallback && !g.stubSlot && /Open in Kiro Crew/.test((await fbButton.textContent().catch(() => '')) || ''), JSON.stringify({ fallback: g.fallback, stub: g.stubSlot }));
  await fbButton.click().catch(() => {});
  const landed = await waitFor(() => page.evaluate(() => (location.pathname.startsWith('/chat/') ? location.pathname : '')), 5000);
  check('"Open in Kiro Crew" goes to the session on the Chat page', landed === `/chat/${encodeURIComponent(mainKey)}`, landed);
  await page.evaluate(() => window.__standinSdk.setChatPanel(true));

  // 8. A launcher that does not name the slot yet: the page opens the same slot itself.
  hostServer.stubCrewSlot = false;
  const posts0 = hostServer.slotPosts.length;
  await page.click('#nav-vscode');
  await page.locator('[data-testid="crew-chatpanel-stub"]').waitFor({ timeout: 10_000 }).catch(() => {});
  await sleep(800);
  g = await geometry(page);
  const posts = hostServer.slotPosts.slice(posts0);
  const create = posts.find((p) => p.path === '/api/chat/slots');
  const raw = await page.evaluate((f) => fetch(`/apps/vscode-pane/api/session?folder=${encodeURIComponent(f)}`).then((r) => r.json()), workspace);
  if (raw && (raw.crewSlot || raw.crewSlotKey || (raw.chatSlot && raw.chatSlot.key))) {
    // The launcher names the slot itself, so the page has nothing to create.
    check('the launcher reports the folder\'s crew slot and the column uses it', g.stubSlot === mainKey && !create, JSON.stringify({ crewSlot: raw.crewSlot, stub: g.stubSlot }));
  } else {
    check('with no crewSlot from the launcher the page creates the launcher\'s slot name itself (crypto.subtle hash matches slotNameFor)',
      create && create.body && create.body.name === mainKey && g.stubSlot === mainKey, JSON.stringify({ posts, stub: g.stubSlot }));
  }
  hostServer.stubCrewSlot = true;

  // 9. VS Code's own Chat view is still there beside the column.
  let chatVisible = await frame.locator('.interactive-input-editor').first().isVisible().catch(() => false);
  for (let i = 0; i < 4 && !chatVisible; i++) {
    await frame.locator('.monaco-workbench').click({ position: { x: 200, y: 200 } }).catch(() => {});
    await page.keyboard.press('Control+Alt+KeyI');
    chatVisible = await frame.locator('.interactive-input-editor').first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
  }
  const aux = await frame.locator('.part.auxiliarybar').first().isVisible().catch(() => false);
  g = await geometry(page);
  check('VS Code\'s own Chat view is still present and opens in its secondary side bar next to the column', chatVisible && aux && !!g.col, `chat ${chatVisible}, auxiliarybar ${aux}, column ${!!g.col}`);

  // 10. Dark-theme screenshot.
  await sleep(800);
  const shot = path.join(shotDir, 'crew-dark.png');
  await page.screenshot({ path: shot });
  check('dark-theme screenshot of the pane with the crew column saved', fs.existsSync(shot), shot);
}
