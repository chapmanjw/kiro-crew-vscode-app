// Kiro Crew Bridge: runs in the VS Code server's extension host (Node).
// Long-polls the vscode-pane launcher for commands and posts editor events
// back. The launcher hands us its address and a per-start secret through
// KIROCREW_VSCODE_BRIDGE_URL / KIROCREW_VSCODE_BRIDGE_SECRET, which the
// extension host inherits from the server process.
//
// It also answers VS Code's Chat view. A default chat participant (proposed
// API `defaultChatParticipant`, enabled for this extension by the launcher's
// --enable-proposed-api flag) forwards each request to the launcher, which
// runs it as a turn in a real Kiro Crew chat session for the open folder and
// streams the reply back. Without the proposal the same handler answers
// `@kirocrew`. The launcher also sends the Kiro Crew colour theme, which is
// written to the user settings only when it differs.
'use strict';

const vscode = require('vscode');
const http = require('http');
const sessions = require('./sessions');

const BRIDGE_URL = process.env.KIROCREW_VSCODE_BRIDGE_URL || '';
const BRIDGE_SECRET = process.env.KIROCREW_VSCODE_BRIDGE_SECRET || '';
// The secret lets its holder run Kiro Crew chat turns, so it is taken out of
// this extension host's environment as soon as we have read it: language
// servers, debug adapters, tasks and other extensions' child processes
// started from here inherit process.env and must not get it. The extension
// activates on "*" so this runs before most other extensions start. A child
// started earlier still has it (see README, Known limits).
delete process.env.KIROCREW_VSCODE_BRIDGE_SECRET;
const VERSION = require('./package.json').version;
// One id per extension host, so the launcher can tell a remounted window's new
// host from the old one that lingers until the server retires it.
const HOST_ID = require('crypto').randomBytes(9).toString('base64url');

let output;
let statusItem;
let crewItem;
let stopped = false;
let connected = false;
let lastError = '';
const chatState = { participant: false, defaultParticipant: false, model: false, modelPublished: false, sessionType: false, sessionModelPublished: false, error: null };
// The "Kiro Crew" chat session type, when the proposal is available (sessions.js).
let sessionsApi = null;
const HIDE_SETTING = 'kiroCrew.chat.hideCopilotAgents';

function hideCopilotAgents() {
  return vscode.workspace.getConfiguration().get(HIDE_SETTING, true) !== false;
}

// The Copilot settings the launcher derives from HIDE_SETTING (backend/lib/chatprefs.mjs).
const COPILOT_AGENT_SETTINGS = ['chat.editor.localAgent.enabled', 'github.copilot.chat.cloudAgent.enabled', 'github.copilot.chat.backgroundAgent.enabled'];

/** The preference plus what VS Code itself now holds for the derived settings. */
function chatPrefsEvent() {
  const cfg = vscode.workspace.getConfiguration();
  const effective = {};
  for (const k of COPILOT_AGENT_SETTINGS) {
    const v = cfg.get(k);
    effective[k] = typeof v === 'boolean' ? v : null;
  }
  return { type: 'chatPrefs', hideCopilotAgents: hideCopilotAgents(), effective };
}

function log(msg) {
  output?.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function request(method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BRIDGE_URL);
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          'x-kiro-bridge-secret': BRIDGE_SECRET,
          ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.setTimeout(timeoutMs || 10000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function postEvent(ev) {
  if (!BRIDGE_URL) return Promise.resolve();
  return request('POST', '/api/bridge/events', ev, 5000).catch((e) => log(`event ${ev.type} failed: ${e.message}`));
}

function setConnected(value, err) {
  connected = value;
  lastError = err || '';
  if (statusItem) {
    statusItem.text = value ? '$(plug) Kiro Crew' : '$(debug-disconnect) Kiro Crew';
    statusItem.tooltip = value ? 'Connected to Kiro Crew' : `Kiro Crew bridge disconnected${err ? ': ' + err : ''}`;
  }
}

function toPosition(line, column) {
  const l = Math.max(0, (Number(line) || 1) - 1);
  const c = Math.max(0, (Number(column) || 1) - 1);
  return new vscode.Position(l, c);
}

async function runCommand(cmd) {
  const uri = cmd.path ? vscode.Uri.file(cmd.path) : undefined;
  switch (cmd.kind) {
    case 'openFile': {
      const doc = await vscode.workspace.openTextDocument(uri);
      const opts = { preview: false, preserveFocus: false };
      if (cmd.line) {
        const pos = toPosition(cmd.line, cmd.column);
        opts.selection = new vscode.Range(pos, pos);
      }
      const editor = await vscode.window.showTextDocument(doc, opts);
      if (opts.selection) editor.revealRange(opts.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }
    case 'openFolder':
      // Report success first: opening a folder reloads this window and ends this host.
      await postEvent({ type: 'result', id: cmd.id, ok: true });
      cmd.__reported = true;
      await vscode.commands.executeCommand('vscode.openFolder', uri, { forceReuseWindow: true });
      return;
    case 'revealInExplorer':
      await vscode.commands.executeCommand('revealInExplorer', uri);
      return;
    case 'applyTheme':
      return applyTheme(cmd.theme);
    case 'askChat': {
      // Opens the Chat view and submits the prompt there. With the Kiro Crew
      // session type as the default the chat is a Kiro Crew session and its
      // own model applies; otherwise the default participant answers on the
      // Kiro Crew model. Resolving the model first and naming it in
      // modelSelector (IChatViewOpenOptions, chatActions.ts) avoids sending
      // before the picker has a model, which fails the request.
      const native = !!sessionsApi && hideCopilotAgents();
      const vendor = native ? sessions.MODEL_VENDOR : 'kiro-crew';
      if (vscode.lm && typeof vscode.lm.selectChatModels === 'function') await vscode.lm.selectChatModels({ vendor });
      if (cmd.newChat) await vscode.commands.executeCommand('workbench.action.chat.newChat');
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: String(cmd.prompt || ''),
        isPartialQuery: false,
        ...(native ? {} : { modelSelector: { vendor: 'kiro-crew', id: 'kiro-crew' } }),
      });
      return;
    }
    case 'setChatPrefs': {
      // Writes the VS Code setting; its change event reports it back to the launcher.
      const want = !!(cmd.prefs && cmd.prefs.hideCopilotAgents);
      const cfg = vscode.workspace.getConfiguration();
      if (cfg.get(HIDE_SETTING, true) !== want) await cfg.update(HIDE_SETTING, want, vscode.ConfigurationTarget.Global);
      else await postEvent(chatPrefsEvent());
      return;
    }
    case 'openChatSession':
      if (!sessionsApi) throw new Error('the Kiro Crew chat session type is not available in this VS Code');
      return sessionsApi.openSession(String(cmd.slot || ''));
    default:
      throw new Error(`unknown command ${cmd.kind}`);
  }
}

async function pollLoop() {
  let backoff = 1000;
  while (!stopped) {
    try {
      const res = await request('GET', `/api/bridge/commands?wait=25&host=${HOST_ID}`, undefined, 35000);
      if (res && res.superseded) {
        // A newer window (the pane was remounted or reloaded) owns the bridge;
        // this host stays quiet until the server retires it.
        if (connected) log('superseded by a newer VS Code window');
        setConnected(false, 'superseded by a newer window');
        continue;
      }
      if (!connected) {
        setConnected(true);
        log('connected');
        sendHello();
        sendEditor(vscode.window.activeTextEditor);
      }
      backoff = 1000;
      for (const cmd of (res && res.commands) || []) {
        log(`command ${cmd.id} ${cmd.kind}${cmd.path ? ' ' + cmd.path : ''}`);
        try {
          await runCommand(cmd);
          if (!cmd.__reported) await postEvent({ type: 'result', id: cmd.id, ok: true });
        } catch (e) {
          log(`command ${cmd.id} failed: ${e.message}`);
          await postEvent({ type: 'result', id: cmd.id, ok: false, error: e.message });
        }
      }
    } catch (e) {
      if (stopped) return;
      setConnected(false, e.message);
      log(`poll failed: ${e.message}; retry in ${backoff} ms`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

function sendHello() {
  return postEvent({
    type: 'hello',
    version: VERSION,
    host: HOST_ID,
    workspaceFolders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
    // Whether this extension host (and so the server process) still carries the
    // gateway's process-tracking variable. A boolean only, never the value.
    spawnTracked: !!process.env.KIROCREW_SPAWN_INSTANCE,
    // Whether the bridge secret is still in this host's environment (it should
    // not be). A boolean only.
    secretInEnv: !!process.env.KIROCREW_VSCODE_BRIDGE_SECRET,
    chat: chatState,
  });
}

// ---------------------------------------------------------------- theme

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * The id this VS Code uses for a built-in theme. 1.146 contributes "Dark
 * Modern"/"Light Modern" where older builds had "Default Dark Modern"/"Default
 * Light Modern", and the workbench rewrites a setting that names the other
 * form, which would make every check look like a change.
 */
function resolveThemeId(name) {
  const ids = new Set();
  for (const ext of vscode.extensions.all) {
    for (const th of ext.packageJSON?.contributes?.themes || []) if (th.id || th.label) ids.add(th.id || th.label);
  }
  const bare = name.replace(/^Default /, '');
  for (const candidate of [name, bare, `Default ${bare}`]) if (ids.has(candidate)) return candidate;
  return name;
}

/**
 * Write the Kiro Crew theme into the user settings, only where it differs, so
 * an unchanged theme never touches settings.json.
 */
async function applyTheme(payload) {
  if (!payload || typeof payload.colorTheme !== 'string' || !payload.colorCustomizations || typeof payload.colorCustomizations !== 'object') {
    throw new Error('bad theme payload');
  }
  const t = { ...payload, colorTheme: resolveThemeId(payload.colorTheme) };
  const cfg = vscode.workspace.getConfiguration();
  const target = vscode.ConfigurationTarget.Global;
  let changed = false;
  const why = [];
  try {
    const curTheme = cfg.inspect('workbench.colorTheme')?.globalValue;
    if (curTheme !== t.colorTheme) {
      why.push(`colorTheme ${curTheme} -> ${t.colorTheme}`);
      await cfg.update('workbench.colorTheme', t.colorTheme, target);
      changed = true;
    }
    // Tier "base" sends no customizations: the stock theme only, so an earlier
    // palette is removed from the user settings rather than left behind.
    const wanted = Object.keys(t.colorCustomizations).length ? t.colorCustomizations : null;
    const curCust = cfg.inspect('workbench.colorCustomizations')?.globalValue;
    const current = curCust && typeof curCust === 'object' && Object.keys(curCust).length ? curCust : null;
    if (stable(current) !== stable(wanted)) {
      const keys = current ? Object.keys(current) : [];
      const diff = wanted ? Object.keys(wanted).find((k) => !current || current[k] !== wanted[k]) || keys.find((k) => !(k in wanted)) : '(cleared)';
      why.push(`colorCustomizations ${keys.length} keys -> ${wanted ? Object.keys(wanted).length : 0}, first difference ${diff}`);
      await cfg.update('workbench.colorCustomizations', wanted ?? undefined, target);
      changed = true;
    }
    log(`theme ${changed ? 'applied' : 'unchanged'} (${t.colorTheme})${why.length ? ': ' + why.join('; ') : ''}`);
    // Read the settings back from a fresh configuration snapshot, so the
    // launcher (and its smoke test) sees what VS Code itself now holds.
    const now = vscode.workspace.getConfiguration();
    const cust = now.get('workbench.colorCustomizations') || {};
    const readBack = {
      colorTheme: now.get('workbench.colorTheme'),
      editorBackground: cust['editor.background'] || null,
      count: Object.keys(cust).length,
    };
    await postEvent({ type: 'theme', signature: t.signature, applied: true, changed, readBack });
  } catch (e) {
    await postEvent({ type: 'theme', signature: t.signature, applied: false, error: e.message });
    throw e;
  }
}

// ---------------------------------------------------------------- chat

/** POST to the launcher and hand each NDJSON line to onPart; the token cancels. */
function streamChat(body, onPart, cancelToken) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/bridge/chat', BRIDGE_URL);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'x-kiro-bridge-secret': BRIDGE_SECRET, 'content-type': 'application/json', 'content-length': data.length },
      },
      (res) => {
        if (res.statusCode >= 400) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`)));
          return;
        }
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (text) => {
          buf += text;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            try {
              onPart(JSON.parse(line));
            } catch (e) {
              log(`chat: bad line ${e.message}`);
            }
          }
        });
        res.on('end', () => resolve());
        res.on('error', (e) => (cancelToken.isCancellationRequested ? resolve() : reject(e)));
      },
    );
    const sub = cancelToken.onCancellationRequested(() => req.destroy(new Error('cancelled')));
    req.on('error', (e) => (cancelToken.isCancellationRequested ? resolve() : reject(e)));
    req.on('close', () => sub.dispose());
    req.write(data);
    req.end();
  });
}

/** The prompt plus the files the user attached and the active editor, as plain text. */
function promptWithReferences(request) {
  const refs = [];
  for (const r of request.references || []) {
    const v = r.value;
    if (v instanceof vscode.Uri && v.scheme === 'file') refs.push(v.fsPath);
    else if (v instanceof vscode.Location && v.uri.scheme === 'file') refs.push(`${v.uri.fsPath}:${v.range.start.line + 1}-${v.range.end.line + 1}`);
  }
  const editor = vscode.window.activeTextEditor;
  const ctx = [];
  if (refs.length) ctx.push(`attached in VS Code: ${refs.join(', ')}`);
  if (editor && editor.document.uri.scheme === 'file') ctx.push(`active file in VS Code: ${editor.document.uri.fsPath}:${editor.selection.start.line + 1}`);
  return ctx.length ? `${request.prompt}\n\n(${ctx.join('; ')})` : request.prompt;
}

async function chatHandler(request, _context, stream, token) {
  const sessionResource = _context && _context.chatSessionContext && _context.chatSessionContext.chatSessionItem && _context.chatSessionContext.chatSessionItem.resource;
  log(`chat request to the default participant${sessionResource ? ' in session ' + sessionResource.toString() : ''}`);
  if (!BRIDGE_URL || !BRIDGE_SECRET) {
    stream.markdown('Kiro Crew is not connected: this VS Code was not started by the Kiro Crew vscode-pane app.');
    return { errorDetails: { message: 'Kiro Crew bridge not configured' } };
  }
  const folder = (vscode.workspace.workspaceFolders || []).find((f) => f.uri.scheme === 'file')?.uri.fsPath;
  let slot = null;
  let failure = null;
  // Tool activity is written inline, not as stream.progress(): the 1.146 chat
  // view folds progress parts, and any text streamed between them, into a
  // collapsed "Completed N steps" group, which would hide the reply itself.
  let atLineStart = true;
  const md = (text) => {
    stream.markdown(text);
    atLineStart = /\n\s*$/.test(text);
  };
  try {
    await streamChat(
      { prompt: promptWithReferences(request), folder: folder || null },
      (part) => {
        switch (part.kind) {
          case 'session':
            slot = part.slot;
            break;
          case 'markdown':
            md(part.text);
            break;
          case 'progress':
            md(`${atLineStart ? '' : '\n\n'}*${String(part.text).replace(/([*_`\\[\]])/g, '\\$1')}*\n\n`);
            break;
          case 'warning':
            md(`\n\n> **Kiro Crew:** ${part.text}\n\n`);
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
  if (token.isCancellationRequested) return { metadata: { slot, cancelled: true } };
  if (failure) {
    log(`chat failed: ${failure}`);
    return { errorDetails: { message: `Kiro Crew: ${failure}` }, metadata: { slot } };
  }
  return { metadata: { slot } };
}

/** Plain text of a language model message (text parts only). */
function messageText(m) {
  return (m.content || [])
    .map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : typeof p === 'string' ? p : ''))
    .join('');
}

/**
 * Kiro Crew as a language model (finalized vscode.lm API). VS Code resolves a
 * model for every chat request before it calls any participant, and only a
 * Copilot model can be the implicit default (extHostLanguageModels.ts,
 * getLanguageModelForRequest / getDefaultLanguageModel). With Copilot signed
 * out there is no model at all and every request fails with "Language model
 * unavailable". This provider puts "Kiro Crew" in the model picker so requests
 * carry a model, and anything that calls the model directly is also answered
 * by a Kiro Crew turn.
 */
function registerLanguageModel(context) {
  const info = {
    id: 'kiro-crew',
    name: 'Kiro Crew',
    family: 'kiro-crew',
    version: VERSION,
    tooltip: 'Runs each request as a turn in a Kiro Crew chat session for the open folder',
    detail: 'Kiro Crew',
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    // Agent mode lists only models that call tools (languageModels.ts
    // suitableForAgentMode). Kiro Crew does run tools, on its own side.
    capabilities: { imageInput: false, toolCalling: true },
  };
  // Registering a provider does not publish its models: the workbench asks a
  // vendor for them only on selectLanguageModels or this change event
  // (languageModels.ts, registerLanguageModelProvider / _resolveAllLanguageModels).
  // Until then the chat picker has no model, a plain message goes out with
  // none, and the extension host fails it with "Language model unavailable"
  // before any participant runs (extHostLanguageModels.ts,
  // getLanguageModelForRequest). That request's own fallback then resolves the
  // models, which is why the second message used to work.
  const changed = new vscode.EventEmitter();
  context.subscriptions.push(changed);
  const provider = {
    onDidChangeLanguageModelChatInformation: changed.event,
    provideLanguageModelChatInformation: () => [info],
    async provideLanguageModelChatResponse(_model, messages, _options, progress, token) {
      const lastUser = [...messages].reverse().find((m) => m.role === vscode.LanguageModelChatMessageRole.User);
      const prompt = lastUser ? messageText(lastUser) : messages.map(messageText).join('\n\n');
      const folder = (vscode.workspace.workspaceFolders || []).find((f) => f.uri.scheme === 'file')?.uri.fsPath;
      let failure = null;
      await streamChat(
        { prompt, folder: folder || null },
        (part) => {
          if (part.kind === 'markdown') progress.report(new vscode.LanguageModelTextPart(part.text));
          else if (part.kind === 'warning') progress.report(new vscode.LanguageModelTextPart(`\n\n> Kiro Crew: ${part.text}\n\n`));
          else if (part.kind === 'error') failure = part.text;
        },
        token,
      );
      if (failure) throw new Error(`Kiro Crew: ${failure}`);
    },
    provideTokenCount: async (_model, text) => Math.ceil((typeof text === 'string' ? text : messageText(text)).length / 4),
  };
  try {
    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('kiro-crew', provider));
    chatState.model = true;
  } catch (e) {
    chatState.error = `language model: ${e.message}`;
    log(chatState.error);
    return;
  }
  publishLanguageModel(changed);
}

/**
 * Make the workbench resolve the Kiro Crew vendor now, so the chat picker
 * holds the Kiro Crew model (chat.defaultModel, set by the launcher, names it)
 * before the user sends anything. selectChatModels goes through
 * $selectChatModels to the workbench's _resolveAllLanguageModels; the change
 * event is a second route to the same resolve.
 */
async function publishLanguageModel(changed) {
  const t0 = Date.now();
  try {
    changed.fire();
    const models = typeof vscode.lm.selectChatModels === 'function' ? await vscode.lm.selectChatModels({ vendor: 'kiro-crew' }) : [];
    chatState.modelPublished = models.some((m) => m.vendor === 'kiro-crew');
    log(`language model ${chatState.modelPublished ? 'published' : 'not published'} in ${Date.now() - t0} ms`);
  } catch (e) {
    chatState.modelPublished = false;
    log(`language model publish failed: ${e.message}`);
  }
  // The launcher may have had the first hello already; tell it the new state.
  if (connected) sendHello();
}

function registerChat(context) {
  if (vscode.lm && typeof vscode.lm.registerLanguageModelChatProvider === 'function') registerLanguageModel(context);
  const icon = vscode.Uri.joinPath(context.extensionUri, 'icon.png');
  // The Kiro Crew session type first, so new chats can open as Kiro Crew
  // sessions; the participants below stay as the fallback (local harness,
  // @kirocrew) and answer alone when the proposal is unavailable.
  try {
    sessionsApi = sessions.register(context, {
      vscode,
      request,
      streamChat,
      log,
      postEvent,
      chatState,
      icon,
      promptWithReferences,
      // The launcher may have had the first hello already; tell it the new state.
      notify: () => {
        if (connected) sendHello();
      },
      workspaceFolder: () => (vscode.workspace.workspaceFolders || []).find((f) => f.uri.scheme === 'file')?.uri.fsPath,
    });
  } catch (e) {
    sessionsApi = null;
    chatState.error = `session type: ${e.message}`;
    log(`Kiro Crew session type failed: ${e.message}`);
  }
  for (const id of ['kiro-crew.default', 'kiro-crew.agent']) {
    try {
      const p = vscode.chat.createChatParticipant(id, chatHandler);
      p.iconPath = icon;
      context.subscriptions.push(p);
      if (id === 'kiro-crew.agent') {
        chatState.participant = true;
        continue;
      }
      // The setter is gated on the defaultChatParticipant proposal
      // (extHostChatAgents2.ts), so it tells us whether VS Code accepted the
      // default participant contribution.
      try {
        p.helpTextPrefix = 'Kiro Crew answers this chat. Each turn runs in a Kiro Crew chat session for the open folder, with its agents, tools and approvals.';
        chatState.defaultParticipant = true;
      } catch (e) {
        chatState.error = `default participant unavailable: ${e.message}`;
        log(chatState.error);
      }
    } catch (e) {
      chatState.error = `${id}: ${e.message}`;
      log(`chat participant ${id} failed: ${e.message}`);
    }
  }
}

function sendEditor(editor) {
  if (!editor || editor.document.uri.scheme !== 'file') {
    return postEvent({ type: 'editor', path: null });
  }
  const s = editor.selection;
  return postEvent({
    type: 'editor',
    path: editor.document.uri.fsPath,
    languageId: editor.document.languageId,
    selection: {
      startLine: s.start.line + 1,
      startColumn: s.start.character + 1,
      endLine: s.end.line + 1,
      endColumn: s.end.character + 1,
    },
  });
}

function activate(context) {
  output = vscode.window.createOutputChannel('Kiro Crew Bridge');
  context.subscriptions.push(output);
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusItem.command = 'kiroCrewBridge.showStatus';
  setConnected(false);
  statusItem.show();
  context.subscriptions.push(statusItem);
  if (vscode.chat && typeof vscode.chat.createChatParticipant === 'function') registerChat(context);

  // Opens or closes the docked Kiro Crew chat column in the app page around
  // this VS Code (ui/, built separately): the launcher counts the toggles in
  // GET /api/session and the page follows the count.
  crewItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  crewItem.name = 'Kiro Crew chat';
  crewItem.text = '$(comment-discussion) Crew';
  crewItem.tooltip = 'Show or hide the Kiro Crew chat (Ctrl+Alt+K)';
  crewItem.accessibilityInformation = { label: 'Show or hide the Kiro Crew chat' };
  crewItem.command = 'kiroCrew.toggleCrewChat';
  context.subscriptions.push(
    crewItem,
    vscode.commands.registerCommand('kiroCrew.toggleCrewChat', () => postEvent({ type: 'toggleCrewChat' })),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kiroCrewBridge.showStatus', () => {
      vscode.window.showInformationMessage(
        connected ? `Kiro Crew bridge connected (${BRIDGE_URL})` : `Kiro Crew bridge not connected${lastError ? ': ' + lastError : ''}`,
      );
    }),
  );

  if (!BRIDGE_URL || !BRIDGE_SECRET) {
    log('KIROCREW_VSCODE_BRIDGE_URL/SECRET not set; bridge idle (not started by the vscode-pane launcher)');
    statusItem.hide();
    return;
  }
  crewItem.show();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(HIDE_SETTING) || COPILOT_AGENT_SETTINGS.some((k) => e.affectsConfiguration(k))) postEvent(chatPrefsEvent());
    }),
  );

  let selTimer;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((e) => sendEditor(e)),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      clearTimeout(selTimer);
      selTimer = setTimeout(() => sendEditor(e.textEditor), 300);
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === 'file') postEvent({ type: 'saved', path: doc.uri.fsPath });
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => sendHello()),
    { dispose: () => { stopped = true; clearTimeout(selTimer); } },
  );

  log(`starting bridge to ${BRIDGE_URL}`);
  // Say hello right away; the first long poll may not return for 25 s.
  sendHello()
    .then(() => sendEditor(vscode.window.activeTextEditor))
    .then(() => postEvent(chatPrefsEvent()));
  pollLoop();
}

function deactivate() {
  stopped = true;
}

module.exports = { activate, deactivate };
