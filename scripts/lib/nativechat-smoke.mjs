// Smoke checks for the "Kiro Crew" chat session type (native VS Code Chat on
// Kiro Crew sessions), run by scripts/smoke.mjs against the real 1.146
// workbench in headless Chrome and the gateway mock.
//
// DOM hooks are the 1.146 workbench's own classes: tool cards render as
// .chat-tool-invocation-part, confirmations as .chat-confirmation-widget(2)
// with .monaco-button buttons.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { slotNameFor } from '../../backend/lib/gateway.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms, step = 300) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return v;
}

/** Focus the Chat input (opening the view when needed), type and send. */
export async function sendInChat(page, frame, text) {
  const box = frame.locator('.interactive-input-editor .monaco-editor').first();
  let open = await box.isVisible().catch(() => false);
  for (let attempt = 0; attempt < 6 && !open; attempt++) {
    await frame.locator('.monaco-workbench').click({ position: { x: 700, y: 300 } });
    await page.keyboard.press('Control+Alt+KeyI');
    open = await box.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
  }
  if (!open) throw new Error('the Chat view did not open');
  await box.click();
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press('Enter');
}

/** True when `slot` is a per-chat Kiro Crew session slot for `workspace` (not the folder slot). */
export function isSessionSlot(slot, workspace) {
  return typeof slot === 'string' && slot.startsWith(slotNameFor(workspace) + '-');
}

const confirmations = (frame, text) => frame.locator('.chat-confirmation-widget, .chat-confirmation-widget2', { hasText: text });

/**
 * The native session checks after the first message (which created session
 * S1). Returns {s1, s2} for the history check after the reload.
 */
export async function nativeChatChecks({ page, frame, api, check, gatewayMock, workspace, firstTurn, root }) {
  const shots = path.join(root, '.cache', 'smoke');
  fs.mkdirSync(shots, { recursive: true });
  const s1 = firstTurn && firstTurn.slot;
  const st0 = (await api('GET', '/api/chat/status')).json;
  check(
    'the bridge registered the Kiro Crew chat session type and published its session model',
    st0 && st0.extension.chat && st0.extension.chat.sessionType === true && st0.extension.chat.sessionModelPublished === true,
    JSON.stringify(st0 && st0.extension.chat),
  );
  const firstSession = st0 && st0.native && st0.native.events.find((e) => e.what === 'created' && e.slot === s1);
  check(
    'the first plain message created a Kiro Crew session of its own (one slot per VS Code chat), pointed at the folder',
    isSessionSlot(s1, workspace) && !!firstSession && String(gatewayMock.rec.slots.get(s1)?.project).toLowerCase() === workspace.toLowerCase(),
    `${s1} project=${gatewayMock.rec.slots.get(s1)?.project} created=${!!firstSession}`,
  );

  // A tool row is a native tool card.
  await until(async () => (await api('GET', '/api/chat/status')).json?.activeTurns === 0, 15_000);
  const toolSel = '.chat-tool-invocation-part, [class*="chat-tool"], [class*="tool-invocation"]';
  // 1.146 folds a reply's tool calls into a "Finished with N steps" group; open it.
  const steps = frame.getByText(/Finished with \d+ steps?/).last();
  if (await steps.isVisible().catch(() => false)) await steps.click().catch(() => {});
  const card = await until(async () => (await frame.locator(toolSel, { hasText: 'Reading hello.txt' }).count().catch(() => 0)) > 0, 15_000);
  await page.screenshot({ path: path.join(shots, 'tool-card.png') }).catch(() => {});
  if (!card) {
    // Where the reply's step group and the card text sit, for a failing run.
    const probe = await frame.locator('body').evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
        if (/Finished with|Reading hello/.test(own)) out.push(`${el.tagName}.${String(el.className).slice(0, 120)} aria-expanded=${el.getAttribute('aria-expanded')} parent=${el.parentElement && String(el.parentElement.className).slice(0, 120)}`);
      }
      return out.join(' | ');
    }).catch((e) => e.message);
    console.log(`tool card probe: ${probe}`);
  }
  const evs = (await api('GET', '/api/chat/status')).json?.native?.events || [];
  check(
    'a Kiro Crew tool row renders as a native VS Code tool card',
    !!card && evs.some((e) => e.what === 'toolCard' && e.slot === s1),
    `card ${!!card}; events ${evs.map((e) => e.what).join(',')}`,
  );

  // An approval shows as VS Code's own confirmation card; Approve reaches the gateway.
  const tagA = crypto.randomBytes(3).toString('hex');
  await sendInChat(page, frame, `approve me ${tagA}`);
  const pending = await until(() => gatewayMock.pendingApprovals()[0], 30_000);
  const shown = await until(async () => (await confirmations(frame, 'Run npm test').count().catch(() => 0)) > 0, 20_000);
  await page.screenshot({ path: path.join(shots, 'approval.png') }).catch(() => {});
  check('an approval request shows as a VS Code confirmation card in the chat', !!pending && !!shown, `pending ${pending}; card ${!!shown}`);
  if (shown) {
    await confirmations(frame, 'Run npm test').last().locator('.monaco-button', { hasText: /^Approve$/ }).first().click();
  }
  const approved = await until(() => gatewayMock.rec.approvals.find((a) => a.requestId === pending && a.action === 'approved'), 15_000);
  const replied = await until(async () => (await frame.locator('text=12 passing').count().catch(() => 0)) > 0, 15_000);
  check(
    'Approve in VS Code reaches Kiro Crew (approve with request_id and a response_id) and the turn continues',
    !!approved && approved.slot === s1 && !!approved.responseId && !!replied,
    JSON.stringify(gatewayMock.rec.approvals.slice(-2)),
  );

  // Decided in Kiro Crew instead: the VS Code card goes away.
  const tagB = crypto.randomBytes(3).toString('hex');
  await sendInChat(page, frame, `approve me ${tagB}`);
  const rid = await until(() => gatewayMock.pendingApprovals()[0], 30_000);
  const shownB = await until(async () => (await confirmations(frame, 'Run npm test').locator('.monaco-button', { hasText: /^Approve$/ }).count().catch(() => 0)) > 0, 20_000);
  const tB = Date.now();
  if (rid) gatewayMock.resolveElsewhere(rid, 'approved');
  const cleared = await until(async () => {
    const st = (await api('GET', '/api/chat/status')).json;
    return st?.native?.events?.some((e) => e.what === 'approvalCleared' && Date.parse(e.at) >= tB - 1000);
  }, 10_000);
  const gone = await until(async () => (await confirmations(frame, 'Run npm test').locator('.monaco-button:visible', { hasText: /^Approve$/ }).count().catch(() => 1)) === 0, 10_000);
  check(
    'an approval decided in Kiro Crew clears the VS Code card',
    !!rid && !!shownB && !!cleared && !!gone,
    `pending ${rid}; card ${!!shownB}; cleared ${!!cleared} in ${Date.now() - tB} ms; gone ${!!gone}`,
  );

  // Without the sessionApproval grant: a clear "approve in Kiro Crew" note, no card.
  gatewayMock.setGrant(false, 'consent_pending');
  const tagC = crypto.randomBytes(3).toString('hex');
  const confirmsBefore = await confirmations(frame, 'Run npm test').count().catch(() => 0);
  await sendInChat(page, frame, `approve me ${tagC}`);
  const ridC = await until(() => gatewayMock.pendingApprovals()[0], 30_000);
  const note = await until(async () => (await frame.locator('text=Approval needed in Kiro Crew').count().catch(() => 0)) > 0, 15_000);
  const noCard = (await confirmations(frame, 'Run npm test').count().catch(() => 0)) === confirmsBefore;
  check('without permissions.sessionApproval the chat says to approve in Kiro Crew instead of showing a card', !!ridC && !!note && noCard, `note ${!!note}; no new card ${noCard}`);
  if (ridC) gatewayMock.resolveElsewhere(ridC, 'approved');
  gatewayMock.setGrant(true);
  await until(async () => (await api('GET', '/api/chat/status')).json?.activeTurns === 0, 15_000);

  // A second VS Code chat session maps to a second slot.
  const prompt2 = `second session ${crypto.randomBytes(3).toString('hex')}`;
  const ask = await api('POST', '/api/chat/ask', { prompt: prompt2, newChat: true });
  const turn2 = await until(() => gatewayMock.rec.turns.find((t) => String(t.message).startsWith(prompt2)), 30_000);
  const s2 = turn2 && turn2.slot;
  const st2 = (await api('GET', '/api/chat/status')).json;
  check(
    'a second VS Code chat session runs in a second Kiro Crew slot',
    ask.json && ask.json.ok && isSessionSlot(s2, workspace) && s2 !== s1 && st2.native.sessions >= 2,
    `${s1} / ${s2}; sessions ${st2 && st2.native && st2.native.sessions}`,
  );
  await until(async () => (await api('GET', '/api/chat/status')).json?.activeTurns === 0, 15_000);

  // GET /api/session names the folder's crew slot for the page's overlay
  // (Ctrl+Alt+K and the status bar item are checked with the Kiro Crew tab).
  const sess = (await api('GET', '/api/session')).json;
  check(
    "GET /api/session names the folder's crew slot {key, folder, title}",
    !!sess.crewSlot && sess.crewSlot.key === slotNameFor(sess.folder) && sess.crewSlot.folder === sess.folder && /^VS Code: /.test(sess.crewSlot.title),
    `crewSlot ${JSON.stringify(sess.crewSlot)}`,
  );

  return { s1, s2 };
}

/** Copilot agents hidden by default, restored live when the setting is flipped, hidden again after. */
export async function copilotAgentChecks({ api, check, machineFile }) {
  const machine = () => JSON.parse(fs.readFileSync(machineFile, 'utf8'));
  const effective = async () => (await api('GET', '/api/chat/status')).json?.native?.vscodePrefs;
  const m0 = machine();
  const e0 = await until(effective, 10_000);
  check(
    "Copilot's local, Cloud and CLI agents are hidden by default (Machine settings and what VS Code holds)",
    m0['chat.editor.localAgent.enabled'] === false && m0['github.copilot.chat.cloudAgent.enabled'] === false && m0['github.copilot.chat.backgroundAgent.enabled'] === false &&
      e0 && e0.hideCopilotAgents === true && e0.effective && e0.effective['chat.editor.localAgent.enabled'] === false && e0.effective['github.copilot.chat.cloudAgent.enabled'] === false &&
      !('chat.disableAIFeatures' in m0),
    JSON.stringify(e0),
  );
  const off = await api('POST', '/api/chat/prefs', { hideCopilotAgents: false });
  const e1 = await until(async () => {
    const e = await effective();
    return e && e.hideCopilotAgents === false && e.effective && e.effective['chat.editor.localAgent.enabled'] === true ? e : null;
  }, 15_000);
  const m1 = machine();
  check(
    'turning kiroCrew.chat.hideCopilotAgents off restores them live (local harness on, Cloud and CLI back to their defaults)',
    off.json && off.json.ok && !!e1 && m1['chat.editor.localAgent.enabled'] === true && !('github.copilot.chat.cloudAgent.enabled' in m1) && !('github.copilot.chat.backgroundAgent.enabled' in m1),
    JSON.stringify({ ok: off.json && off.json.ok, effective: e1 && e1.effective }),
  );
  await api('POST', '/api/chat/prefs', { hideCopilotAgents: true });
  const e2 = await until(async () => {
    const e = await effective();
    return e && e.hideCopilotAgents === true && e.effective && e.effective['chat.editor.localAgent.enabled'] === false ? e : null;
  }, 15_000);
  check('turning it back on hides them again', !!e2 && machine()['chat.editor.localAgent.enabled'] === false, JSON.stringify(e2 && e2.effective));
}

/** After a window reload: opening a session restores its history from the slot. */
export async function historyChecks({ frame, api, check, slot, since }) {
  const open = await api('POST', '/api/chat/open-session', { slot });
  const ev = await until(async () => {
    const st = (await api('GET', '/api/chat/status')).json;
    return st?.native?.events?.find((e) => e.what === 'content' && e.slot === slot && Date.parse(e.at) >= since - 1000);
  }, 20_000);
  // The chat list is virtualized and opens scrolled to the end, so look for
  // the session's last reply; the Chat view itself starts empty after a reload.
  const shown = await until(async () => (await frame.locator('text=12 passing').count().catch(() => 0)) > 0, 15_000);
  check(
    'after the window reloads, reopening a Kiro Crew session restores its history from the slot',
    open.json && open.json.ok && ev && ev.turns >= 2 && !!shown,
    JSON.stringify({ open: open.json && open.json.ok, turns: ev && ev.turns, shown: !!shown }),
  );
}

/**
 * VS Code's own surfaces list the Kiro Crew session type: the harness picker
 * under the chat input ("Session Target") and the web build's Agent Sessions
 * sidebar (the browser workbench has no separate Agents window). Screenshots
 * go to `shotDir` (session-target.png, agent-sessions.png).
 */
export async function sessionTargetChecks({ page, frame, check, shotDir }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const items = () => frame.locator('.context-view .monaco-list-row, .action-widget .monaco-list-row').evaluateAll((els) => els.map((r) => (r.getAttribute('aria-label') || r.textContent || '').trim()));
  let listed = [];
  let label = '';
  for (let attempt = 0; attempt < 3 && !listed.some((t) => /^Kiro Crew/.test(t)); attempt++) {
    await frame.locator('.monaco-workbench .part.editor').first().click({ position: { x: 200, y: 160 } }).catch(() => {});
    await page.keyboard.press('Control+Alt+KeyI');
    await sleep(1500);
    const picker = frame.locator('.interactive-input-part .dropdown-label a.action-label').filter({ hasText: /Kiro Crew|Copilot|Local/ }).first();
    label = ((await picker.textContent({ timeout: 5000 }).catch(() => '')) || '').trim();
    await picker.click({ timeout: 5000 }).catch(() => {});
    await sleep(1000);
    listed = await items().catch(() => []);
  }
  await page.screenshot({ path: `${shotDir}/session-target.png` }).catch(() => {});
  check('VS Code\'s session target picker under the chat input lists "Kiro Crew" (and it is the current one)',
    listed.some((t) => /^Kiro Crew/.test(t)) && label === 'Kiro Crew', `current "${label}"; listed ${JSON.stringify(listed.map((t) => t.slice(0, 40)))}`);
  await page.keyboard.press('Escape');
  await sleep(400);
  await page.keyboard.press('Control+Shift+KeyP');
  await frame.locator('.quick-input-widget input').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await page.keyboard.type('Chat Agent Sessions: Show Agent Sessions Sidebar', { delay: 5 });
  await sleep(600);
  await page.keyboard.press('Enter');
  let rows = [];
  const t = Date.now();
  while (Date.now() - t < 10_000) {
    rows = await frame.locator('[aria-label="Agent Sessions"] .monaco-list-row, .agent-sessions-viewer .monaco-list-row').evaluateAll((els) => els.map((r) => (r.getAttribute('aria-label') || r.textContent || '').trim())).catch(() => []);
    if (rows.length) break;
    await sleep(500);
  }
  await sleep(500);
  await page.screenshot({ path: `${shotDir}/agent-sessions.png` }).catch(() => {});
  check('VS Code\'s Agent Sessions sidebar lists the Kiro Crew chat sessions', rows.length > 0, JSON.stringify(rows.slice(0, 6).map((r) => r.slice(0, 80))));
  await page.keyboard.press('Control+Shift+KeyP');
  await frame.locator('.quick-input-widget input').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await page.keyboard.type('Chat Agent Sessions: Hide Agent Sessions Sidebar', { delay: 5 });
  await sleep(600);
  await page.keyboard.press('Enter');
  await sleep(500);
}
