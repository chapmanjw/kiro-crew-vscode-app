// "Kiro Crew" as a native VS Code chat session type.
//
// Proposed API chatSessionsProvider (VS Code 1.146, enabled for this
// extension by the launcher's --enable-proposed-api flag), following the shape
// of RabbitShare/acp-to-chat (src/extension.ts register()) and VS Code's own
// Copilot CLI provider (extensions/copilot/src/extension/chatSessions/copilotcli):
//  - package.json contributes chatSessions type "kirocrew"; a participant
//    whose id equals the type receives the native sends for it.
//  - createChatSessionItemController lists the sessions (one Kiro Crew slot
//    each, kept by the launcher) and newChatSessionItemHandler creates one.
//  - registerChatSessionContentProvider rebuilds a session's history from the
//    slot (ChatRequestTurn2 / ChatResponseTurn2).
//  - a metadata-only language model with targetChatSessionType "kirocrew"
//    satisfies the request's model resolution (chatProvider proposal).
//  - replies stream as markdown, tool rows as ChatToolInvocationPart cards,
//    and approvals as the workbench's own inline confirmation card through the
//    core tool vscode_get_confirmation_with_options (as the Copilot CLI
//    provider does in node/permissionHelpers.ts), relayed to the gateway.
'use strict';

const path = require('path');

const SESSION_TYPE = 'kirocrew';
const MODEL_VENDOR = 'kirocrew';
const CONFIRM_TOOL = 'vscode_get_confirmation_with_options';
const APPROVE = 'Approve';
const REJECT = 'Reject';

function available(vscode) {
  return !!(
    vscode.chat &&
    typeof vscode.chat.createChatSessionItemController === 'function' &&
    typeof vscode.chat.registerChatSessionContentProvider === 'function' &&
    typeof vscode.chat.createChatParticipant === 'function'
  );
}

/** "{\"command\":\"npm test\"}" -> "npm test"; anything else -> ''. */
function commandOf(input) {
  if (!input) return '';
  try {
    const v = JSON.parse(input);
    if (v && typeof v === 'object') return String(v.command || v.cmd || v.commandLine || '');
  } catch {
    /* not JSON */
  }
  return '';
}

/**
 * A native tool card for a tool part from the launcher. `live` cards set
 * enablePartialUpdate, which 1.146 turns into an external tool invocation
 * that later parts with the same id update in place
 * (extHostTypeConverters ChatToolInvocationPart: externalToolInvocationUpdate);
 * history cards leave it off and render as finished (toolInvocationSerialized).
 */
function toolCard(vscode, t, live) {
  const part = new vscode.ChatToolInvocationPart(t.toolKind || 'kirocrew', t.id);
  part.invocationMessage = t.title;
  part.pastTenseMessage = t.title;
  part.isConfirmed = true;
  part.isComplete = t.state === 'done' || t.state === 'error';
  part.isError = t.state === 'error';
  part.enablePartialUpdate = !!live;
  const cmd = t.toolKind === 'execute' ? commandOf(t.input) : '';
  if (cmd) {
    part.toolSpecificData = {
      commandLine: { original: cmd },
      language: process.platform === 'win32' ? 'powershell' : 'sh',
      ...(t.output ? { output: { text: t.output } } : {}),
    };
  } else if (t.input || t.output) {
    part.toolSpecificData = { input: t.input || '', output: t.output || '' };
  }
  return part;
}

function markdownString(vscode, text) {
  const m = new vscode.MarkdownString(text);
  m.isTrusted = false;
  m.supportHtml = false;
  return m;
}

/**
 * invokeTool for the workbench's confirmation tool. The core registers it in
 * the "chat.builtinTools" contribution at LifecyclePhase.Eventually (1.146
 * builtinTools: bt(uOe.ID, uOe, vt.Eventually)), so right after a window
 * opens it can still be missing ("Tool ... was not contributed"); retry for a
 * while before giving up.
 */
async function invokeConfirmation(vscode, input, toolInvocationToken, token, { tries = 20, waitMs = 750 } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await vscode.lm.invokeTool(CONFIRM_TOOL, { input, toolInvocationToken }, token);
    } catch (e) {
      if (i >= tries - 1 || token.isCancellationRequested || !/not contributed/i.test(e.message || '')) throw e;
      await new Promise((r) => setTimeout(r, waitMs));
      if (token.isCancellationRequested) throw e;
    }
  }
}

/** Escape text for a markdown line. */
function md(s) {
  return String(s || '').replace(/([\\`*_[\]<>])/g, '\\$1');
}

/**
 * @param {import('vscode').ExtensionContext} context
 * @param {{vscode:any, request:Function, streamChat:Function, log:Function, postEvent:Function,
 *          chatState:object, workspaceFolder:()=>string|undefined, icon:any}} deps
 * @returns {{openSession:(slot:string)=>Promise<void>, sessionCount:()=>number}|null}
 */
function register(context, deps) {
  const { vscode, request, streamChat, log, postEvent, chatState, workspaceFolder, icon } = deps;
  if (!available(vscode)) {
    log('Kiro Crew session type not registered: chatSessionsProvider proposal unavailable; the default participant answers instead');
    return null;
  }
  const event = (what, extra = {}) => postEvent({ type: 'chatSession', what, ...extra });

  // A metadata-only model for this session type. Generation stays in the
  // participant; a direct model call is refused, as acp-to-chat does.
  if (vscode.lm && typeof vscode.lm.registerLanguageModelChatProvider === 'function') {
    try {
      context.subscriptions.push(
        vscode.lm.registerLanguageModelChatProvider(MODEL_VENDOR, {
          provideLanguageModelChatInformation: () => [
            {
              id: 'kirocrew',
              name: 'Kiro Crew',
              family: 'kirocrew',
              version: '',
              tooltip: 'Kiro Crew picks the agent and model for this session',
              detail: 'Kiro Crew',
              maxInputTokens: 0,
              maxOutputTokens: 0,
              isDefault: true,
              isUserSelectable: true,
              targetChatSessionType: SESSION_TYPE,
              capabilities: { toolCalling: true, imageInput: false },
            },
          ],
          provideLanguageModelChatResponse: () => {
            throw new Error('Kiro Crew answers in a Kiro Crew chat session; this model is not called directly.');
          },
          provideTokenCount: async () => 0,
        }),
      );
    } catch (e) {
      log(`session model failed: ${e.message}`);
    }
  }

  const resourceFor = (slot) => vscode.Uri.from({ scheme: SESSION_TYPE, path: `/${slot}` });
  const slotOf = (resource) => (resource && resource.scheme === SESSION_TYPE ? resource.path.replace(/^\/+/, '') : '');
  const isDraft = (slot) => !slot || slot.startsWith('untitled-') || slot.startsWith('untitled');
  const known = new Map(); // slot -> {slot, folder, title, created, updated}
  const status = new Map(); // slot -> ChatSessionStatus
  const drafts = new Map(); // draft resource string -> Promise<session>
  let lastNew = null; // {at, promise} from newChatSessionItemHandler, claimed by the first draft send

  let controller;
  const itemFor = (s) => {
    const item = controller.createChatSessionItem(resourceFor(s.slot), s.title || 'Kiro Crew chat');
    item.iconPath = icon;
    item.description = path.basename(s.folder || '') || undefined;
    item.tooltip = `Kiro Crew session ${s.slot}`;
    item.status = status.has(s.slot) ? status.get(s.slot) : vscode.ChatSessionStatus.Completed;
    item.timing = { created: s.created || Date.now(), ...(s.updated ? { lastRequestEnded: s.updated } : {}) };
    return item;
  };
  const show = (s) => {
    known.set(s.slot, s);
    controller.items.add(itemFor(s));
  };
  const setStatus = (slot, st) => {
    status.set(slot, st);
    const s = known.get(slot);
    if (s) controller.items.add(itemFor(s));
  };

  async function refresh() {
    try {
      const r = await request('GET', '/api/bridge/sessions');
      const list = (r && r.sessions) || [];
      for (const s of list) known.set(s.slot, s);
      controller.items.replace(list.map(itemFor));
    } catch (e) {
      log(`session list failed: ${e.message}`);
    }
  }

  async function createSession(prompt) {
    const folder = workspaceFolder();
    if (!folder) throw new Error('Open a folder to start a Kiro Crew chat session.');
    const r = await request('POST', '/api/bridge/sessions', { folder, title: prompt || '' });
    if (!r || !r.session) throw new Error('Kiro Crew did not create a session');
    show(r.session);
    event('created', { slot: r.session.slot });
    return r.session;
  }

  /** The session for a request's resource; a draft is created on its first send. */
  async function sessionFor(resource, prompt) {
    const slot = slotOf(resource);
    if (slot && !isDraft(slot)) {
      if (known.has(slot)) return known.get(slot);
      await refresh();
      if (known.has(slot)) return known.get(slot);
      throw new Error(`Kiro Crew session ${slot} is not known to this window`);
    }
    const key = resource ? resource.toString() : 'draft';
    if (!drafts.has(key)) {
      // The workbench may already have called newChatSessionItemHandler for
      // this send; use that session rather than creating a second slot.
      const fresh = lastNew && Date.now() - lastNew.at < 15000 ? lastNew.promise : null;
      lastNew = null;
      drafts.set(key, fresh || createSession(prompt));
    }
    try {
      return await drafts.get(key);
    } catch (e) {
      drafts.delete(key);
      throw e;
    }
  }

  // ------------------------------------------------------------ approvals

  /**
   * Ask in VS Code, with the workbench's inline confirmation card. Falls back
   * to a quick pick when the core confirmation tool is missing (it is
   * internal API).
   */
  async function askApproval(req, title, message, token) {
    if (vscode.lm && typeof vscode.lm.invokeTool === 'function') {
      try {
        const r = await invokeConfirmation(vscode, { title, message, buttons: [APPROVE, REJECT] }, req.toolInvocationToken, token);
        const first = r && r.content && r.content[0];
        return approvalFromConfirmation(first && first.value);
      } catch (e) {
        if (token.isCancellationRequested) return null;
        // A denied confirmation throws a cancellation (languageModelToolsService
        // invokeTool: awaitConfirmation type 0 -> CancellationError).
        if (/cancel/i.test(e.name || '') || /cancel/i.test(e.message || '')) return 'rejected';
        log(`confirmation card unavailable (${e.message}); using a quick pick`);
      }
    }
    const pick = await vscode.window.showQuickPick([APPROVE, REJECT], { title, placeHolder: message, ignoreFocusOut: true }, token);
    if (token.isCancellationRequested) return null;
    return pick === APPROVE ? 'approved' : 'rejected';
  }

  /** One approval card's life: shown, answered here or in Kiro Crew, relayed. */
  async function handleApproval(ctx, part) {
    const { slot, req, stream, cancels } = ctx;
    const what = part.input ? `\n\n\`${md(part.input).slice(0, 2000)}\`` : '';
    if (!part.grant || part.grant.granted === false || !part.requestId) {
      stream.markdown(`\n\n> **Approval needed in Kiro Crew:** ${md(part.title)}. ${md(part.grant && part.grant.message)}\n\n`);
      setStatus(slot, vscode.ChatSessionStatus.NeedsInput);
      event('approvalFallback', { slot, detail: part.grant && part.grant.cause });
      return;
    }
    const cts = new vscode.CancellationTokenSource();
    cancels.set(part.requestId, cts);
    setStatus(slot, vscode.ChatSessionStatus.NeedsInput);
    event('approvalShown', { slot, detail: part.requestId });
    let action;
    try {
      action = await askApproval(req, `Kiro Crew: ${part.title}`, `Kiro Crew wants to run this tool.${part.purpose ? ' ' + part.purpose : ''}${what}`, cts.token);
    } finally {
      cancels.delete(part.requestId);
      cts.dispose();
      if (status.get(slot) === vscode.ChatSessionStatus.NeedsInput) setStatus(slot, vscode.ChatSessionStatus.InProgress);
    }
    if (!action) return; // decided in Kiro Crew, or the turn ended
    const r = await request('POST', '/api/bridge/approve', { slot, requestId: part.requestId, action }).catch((e) => ({ ok: false, error: e.message }));
    event('approvalAnswered', { slot, detail: `${action}:${r && r.ok ? 'ok' : (r && r.code) || 'failed'}` });
    if (r && r.ok) return;
    if (r && r.code === 'session_approval_not_granted') {
      stream.markdown(`\n\n> **Approve in Kiro Crew:** ${md(r.message || r.error)}\n\n`);
    } else if (r && r.code !== 'approval_not_pending') {
      stream.markdown(`\n\n> **Kiro Crew:** the ${action === 'approved' ? 'approval' : 'rejection'} did not reach Kiro Crew (${md(r && r.error)}). Decide it in the Kiro Crew session.\n\n`);
    }
  }

  /** A blocking question card: each question answered with the confirmation card's buttons. */
  async function handleQuestion(ctx, card) {
    const { slot, req, cancels } = ctx;
    const cts = new vscode.CancellationTokenSource();
    cancels.set(`q:${card.askId}`, cts);
    setStatus(slot, vscode.ChatSessionStatus.NeedsInput);
    event('questionShown', { slot, detail: card.askId });
    const answers = {};
    let dismissed = false;
    try {
      for (const q of card.questions) {
        let answer = null;
        if (q.options.length && vscode.lm && typeof vscode.lm.invokeTool === 'function') {
          try {
            const r = await invokeConfirmation(vscode, { title: `Kiro Crew asks${q.header ? ': ' + q.header : ''}`, message: q.question, buttons: q.options }, req.toolInvocationToken, cts.token);
            const v = r && r.content && r.content[0] && r.content[0].value;
            answer = q.options.includes(v) ? v : null;
          } catch {
            answer = null;
          }
        } else {
          answer = await vscode.window.showInputBox({ title: 'Kiro Crew asks', prompt: q.question, ignoreFocusOut: true }, cts.token);
        }
        if (cts.token.isCancellationRequested) return;
        if (!answer) {
          dismissed = true;
          break;
        }
        answers[q.question] = answer;
      }
    } finally {
      cancels.delete(`q:${card.askId}`);
      cts.dispose();
      if (status.get(slot) === vscode.ChatSessionStatus.NeedsInput) setStatus(slot, vscode.ChatSessionStatus.InProgress);
    }
    const r = await request('POST', '/api/bridge/question', dismissed ? { slot, askId: card.askId, dismissed: true } : { slot, askId: card.askId, answers }).catch((e) => ({ ok: false, error: e.message }));
    event('questionAnswered', { slot, detail: r && r.ok ? 'ok' : (r && r.code) || 'failed' });
  }

  // ------------------------------------------------------------ requests

  async function handle(resource, req, chatContext, stream, token) {
    log(`session request for ${resource ? resource.toString() : '(no resource)'}`);
    const prompt = req.command ? `/${req.command}${req.prompt ? ' ' + req.prompt : ''}` : req.prompt;
    const s = await sessionFor(resource, prompt);
    const folder = s.folder || workspaceFolder();
    const ctx = { slot: s.slot, req, stream, cancels: new Map() };
    const tools = new Set();
    const waits = [];
    let failure = null;
    setStatus(s.slot, vscode.ChatSessionStatus.InProgress);
    event('turn', { slot: s.slot });
    try {
      await streamChat(
        { prompt: deps.promptWithReferences(req), folder, slot: s.slot, title: s.title },
        (part) => {
          switch (part.kind) {
            case 'markdown':
              stream.markdown(part.text);
              break;
            case 'thinking':
              if (vscode.ChatResponseThinkingProgressPart) stream.push(new vscode.ChatResponseThinkingProgressPart(part.text));
              break;
            case 'tool':
              stream.push(toolCard(vscode, part, true));
              if (!tools.has(part.id)) event('toolCard', { slot: s.slot, detail: part.title });
              tools.add(part.id);
              break;
            case 'approval':
              waits.push(handleApproval(ctx, part).catch((e) => log(`approval failed: ${e.message}`)));
              break;
            case 'approvalResolved': {
              const cts = ctx.cancels.get(part.requestId);
              if (cts) {
                cts.cancel();
                if (part.resolved !== 'ended') stream.markdown(`\n\n*${md(part.resolved === 'approved' ? 'Approved' : part.resolved)} in Kiro Crew.*\n\n`);
                event('approvalCleared', { slot: s.slot, detail: part.resolved });
              }
              break;
            }
            case 'question':
              waits.push(handleQuestion(ctx, part).catch((e) => log(`question failed: ${e.message}`)));
              break;
            case 'questionResolved': {
              const cts = ctx.cancels.get(`q:${part.askId}`);
              if (cts) cts.cancel();
              break;
            }
            case 'warning':
              stream.markdown(`\n\n> **Kiro Crew:** ${part.text}\n\n`);
              break;
            case 'notice':
              stream.markdown(`\n\n*${md(part.text)}*\n\n`);
              break;
            case 'error':
              failure = part.text;
              break;
            default:
              break;
          }
        },
        token,
      );
    } catch (e) {
      failure = e.message;
    }
    for (const c of ctx.cancels.values()) c.cancel();
    await Promise.all(waits);
    s.updated = Date.now();
    if (token.isCancellationRequested) {
      setStatus(s.slot, vscode.ChatSessionStatus.Completed);
      return {};
    }
    if (failure) {
      setStatus(s.slot, vscode.ChatSessionStatus.Failed);
      log(`session turn failed: ${failure}`);
      // A session handler's ChatResult is not shown; a thrown error is (acp-to-chat).
      throw new Error(`Kiro Crew: ${failure}`);
    }
    setStatus(s.slot, vscode.ChatSessionStatus.Completed);
    return {};
  }

  // ------------------------------------------------------------ history

  function historyFor(turns) {
    const out = [];
    for (const t of turns || []) {
      if (t.role === 'user') {
        out.push(new vscode.ChatRequestTurn2(t.text || '', undefined, [], SESSION_TYPE, [], undefined, undefined, undefined, undefined));
      } else if (t.role === 'assistant') {
        const parts = [];
        for (const p of t.parts || []) {
          if (p.kind === 'markdown') parts.push(new vscode.ChatResponseMarkdownPart(markdownString(vscode, p.text)));
          else if (p.kind === 'tool') parts.push(toolCard(vscode, p, false));
        }
        out.push(new vscode.ChatResponseTurn2(parts, {}, SESSION_TYPE));
      }
    }
    return out;
  }

  const participant = vscode.chat.createChatParticipant(SESSION_TYPE, (req, chatContext, stream, token) => {
    const resource = chatContext && chatContext.chatSessionContext && chatContext.chatSessionContext.chatSessionItem && chatContext.chatSessionContext.chatSessionItem.resource;
    if (!resource || resource.scheme !== SESSION_TYPE) {
      // @kirocrew in another session type is answered by the 0.3.1 participants.
      throw new Error('Start a Kiro Crew chat session for this, or ask @kirocrew.');
    }
    return handle(resource, req, chatContext, stream, token);
  });
  if (icon) participant.iconPath = icon;
  context.subscriptions.push(participant);

  controller = vscode.chat.createChatSessionItemController(SESSION_TYPE, () => refresh());
  context.subscriptions.push(controller);
  controller.newChatSessionItemHandler = (ctxNew) => {
    const promise = createSession(ctxNew && ctxNew.request ? ctxNew.request.prompt : '');
    lastNew = { at: Date.now(), promise };
    return promise.then((s) => itemFor(s));
  };

  context.subscriptions.push(
    vscode.chat.registerChatSessionContentProvider(
      SESSION_TYPE,
      {
        async provideChatSessionContent(resource) {
          const slot = slotOf(resource);
          const requestHandler = (req, chatContext, stream, token) => handle(resource, req, chatContext, stream, token);
          if (isDraft(slot)) return { title: 'Kiro Crew', history: [], requestHandler };
          let r = null;
          try {
            r = await request('GET', `/api/bridge/sessions/history?slot=${encodeURIComponent(slot)}`, undefined, 20000);
          } catch (e) {
            log(`session history failed: ${e.message}`);
          }
          if (r && r.session) known.set(r.session.slot, r.session);
          const history = historyFor(r && r.turns);
          event('content', { slot, turns: history.length });
          return { title: (r && r.session && r.session.title) || 'Kiro Crew', history, requestHandler };
        },
      },
      participant,
      { supportsInterruptions: false },
    ),
  );

  chatState.sessionType = true;
  refresh();
  if (vscode.lm && typeof vscode.lm.selectChatModels === 'function') {
    // Registration alone does not publish the model (acp-to-chat extension.ts:424):
    // this resolves the vendor in the workbench. A model bound to a session
    // type is not handed back to extensions, so the list itself may be empty.
    Promise.resolve(vscode.lm.selectChatModels({ vendor: MODEL_VENDOR }))
      .then(() => {
        chatState.sessionModelPublished = true;
        if (deps.notify) deps.notify();
      })
      .catch((e) => log(`session model publish failed: ${e.message}`));
  }
  log('Kiro Crew chat session type registered');

  return {
    async openSession(slot) {
      if (!known.has(slot)) await refresh();
      await vscode.commands.executeCommand('vscode.open', resourceFor(slot), { preview: false });
    },
    sessionCount: () => known.size,
  };
}

/**
 * The decision a confirmation card's answer means. Only the Approve button
 * approves. 'yes' is what the tool returns when no button was picked
 * (auto-confirm, a default accept: confirmationTool.ts:211-218), which must
 * never approve a Kiro Crew tool call.
 */
function approvalFromConfirmation(value) {
  return value === APPROVE ? 'approved' : 'rejected';
}

module.exports = { register, approvalFromConfirmation, available, toolCard, commandOf, invokeConfirmation, SESSION_TYPE, MODEL_VENDOR, CONFIRM_TOOL };
