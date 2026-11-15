// The bridge extension's "Kiro Crew" chat session type (sessions.js) against a
// fake `vscode`: registration, tool cards, approvals through the workbench's
// confirmation tool, clearing a card decided in Kiro Crew, the no-grant
// fallback and the history rebuilt from the slot.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'extension', 'kiro-crew-bridge', 'sessions.js');
const sessions = Module.createRequire(FILE)(FILE);

function fakeVscode({ withProposal = true, invokeTool } = {}) {
  const rec = { participants: [], controllers: [], content: [], models: [], invoked: [], items: new Map(), commands: [] };
  class CancellationTokenSource {
    constructor() {
      this.listeners = [];
      this.token = {
        isCancellationRequested: false,
        onCancellationRequested: (fn) => {
          this.listeners.push(fn);
          return { dispose() {} };
        },
      };
    }
    cancel() {
      if (this.token.isCancellationRequested) return;
      this.token.isCancellationRequested = true;
      for (const fn of this.listeners) fn();
    }
    dispose() {}
  }
  class ChatToolInvocationPart {
    constructor(toolName, toolCallId) {
      this.toolName = toolName;
      this.toolCallId = toolCallId;
    }
  }
  class MarkdownString {
    constructor(value) {
      this.value = value;
    }
  }
  class ChatResponseMarkdownPart {
    constructor(value) {
      this.value = value;
    }
  }
  class ChatRequestTurn2 {
    constructor(prompt, command, references, participant) {
      Object.assign(this, { prompt, command, references, participant });
    }
  }
  class ChatResponseTurn2 {
    constructor(response, result, participant) {
      Object.assign(this, { response, result, participant });
    }
  }
  class ChatResponseThinkingProgressPart {
    constructor(value) {
      this.value = value;
    }
  }
  const vscode = {
    CancellationTokenSource,
    ChatToolInvocationPart,
    MarkdownString,
    ChatResponseMarkdownPart,
    ChatRequestTurn2,
    ChatResponseTurn2,
    ChatResponseThinkingProgressPart,
    ChatSessionStatus: { Failed: 0, Completed: 1, InProgress: 2, NeedsInput: 3 },
    Uri: { from: ({ scheme, path: p }) => ({ scheme, path: p, toString: () => `${scheme}:${p}` }) },
    window: { showQuickPick: async () => 'Approve', showInputBox: async () => 'typed' },
    commands: { executeCommand: async (...a) => rec.commands.push(a) },
    lm: {
      registerLanguageModelChatProvider: (vendor, p) => {
        rec.models.push({ vendor, info: p.provideLanguageModelChatInformation()[0] });
        return { dispose() {} };
      },
      selectChatModels: async ({ vendor }) => [{ vendor }],
      invokeTool: invokeTool || (async (name, opts) => {
        rec.invoked.push({ name, input: opts.input });
        return { content: [{ value: 'Approve' }] };
      }),
    },
    chat: withProposal
      ? {
          createChatParticipant: (id, handler) => {
            const p = { id, handler, dispose() {} };
            rec.participants.push(p);
            return p;
          },
          createChatSessionItemController: (type, refresh) => {
            const c = {
              type,
              refresh,
              items: {
                add: (item) => rec.items.set(item.resource.path, item),
                replace: (items) => {
                  rec.items.clear();
                  for (const i of items) rec.items.set(i.resource.path, i);
                },
              },
              createChatSessionItem: (resource, label) => ({ resource, label }),
              dispose() {},
            };
            rec.controllers.push(c);
            return c;
          },
          registerChatSessionContentProvider: (scheme, provider, participant, caps) => {
            rec.content.push({ scheme, provider, participant, caps });
            return { dispose() {} };
          },
        }
      : { createChatParticipant: () => ({ dispose() {} }) },
  };
  return { vscode, rec };
}

function setup({ parts = [], withProposal = true, invokeTool, history = [] } = {}) {
  const { vscode, rec } = fakeVscode({ withProposal, invokeTool });
  const requests = [];
  const events = [];
  const chatState = {};
  let feed = parts;
  const deps = {
    vscode,
    log: () => {},
    chatState,
    icon: null,
    postEvent: async (e) => events.push(e),
    promptWithReferences: (req) => req.prompt,
    workspaceFolder: () => 'C:\\work\\demo',
    request: async (method, p, body) => {
      requests.push({ method, p, body });
      if (method === 'GET' && p === '/api/bridge/sessions') return { sessions: [] };
      if (method === 'POST' && p === '/api/bridge/sessions') return { session: { slot: 'vscode-demo-abc-1111', folder: body.folder, title: body.title || 'New chat', created: 1 } };
      if (method === 'GET' && p.startsWith('/api/bridge/sessions/history')) return { session: { slot: 'vscode-demo-abc-1111', folder: 'C:\\work\\demo', title: 'old' }, turns: history };
      if (p === '/api/bridge/approve') return { ok: true };
      return null;
    },
    streamChat: async (body, onPart, token) => {
      requests.push({ method: 'STREAM', p: '/api/bridge/chat', body });
      for (const part of typeof feed === 'function' ? await feed(token) : feed) {
        onPart(part);
        await new Promise((r) => setImmediate(r));
      }
    },
  };
  const api = sessions.register({ subscriptions: [] }, deps);
  const stream = { out: [], markdown(t) { this.out.push({ md: t }); }, push(p) { this.out.push({ part: p }); } };
  return { api, rec, requests, events, chatState, stream, setFeed: (f) => (feed = f) };
}

const draftContext = { chatSessionContext: { chatSessionItem: { resource: { scheme: 'kirocrew', path: '/untitled-1', toString: () => 'kirocrew:/untitled-1' } } } };
const token = () => ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });

test('without the chatSessionsProvider proposal nothing is registered (the 0.3.1 participant answers)', () => {
  const { api, rec } = setup({ withProposal: false });
  assert.equal(api, null);
  assert.equal(rec.participants.length, 0);
});

test('registers the session type: participant id = type, content provider bound to it, a session-only model', () => {
  const { rec, chatState } = setup();
  assert.deepEqual(rec.participants.map((p) => p.id), ['kirocrew']);
  assert.equal(rec.controllers[0].type, 'kirocrew');
  assert.equal(rec.content[0].scheme, 'kirocrew');
  assert.equal(rec.content[0].participant, rec.participants[0]);
  assert.equal(rec.models[0].vendor, 'kirocrew');
  assert.equal(rec.models[0].info.targetChatSessionType, 'kirocrew');
  assert.equal(rec.models[0].info.isDefault, true);
  assert.equal(chatState.sessionType, true);
});

test('a first send in a draft creates one session, streams text and native tool cards, and relays an approval', async () => {
  const { rec, requests, stream, events } = setup({
    parts: [
      { kind: 'session', slot: 'vscode-demo-abc-1111', native: true },
      { kind: 'markdown', text: 'Hello' },
      { kind: 'tool', id: 'kc-tool-1', title: 'Run npm test', state: 'running' },
      { kind: 'approval', requestId: 'req-1', title: 'Run npm test', toolKind: 'execute', input: 'npm test', purpose: '', grant: { granted: true } },
      { kind: 'tool', id: 'kc-tool-1', title: 'Run npm test', state: 'done', toolKind: 'execute', input: '{"command":"npm test"}', output: '12 passing' },
    ],
  });
  const result = await rec.participants[0].handler({ prompt: 'run the tests', toolInvocationToken: 'tok' }, draftContext, stream, token());
  assert.deepEqual(result, {});
  assert.equal(requests.filter((r) => r.p === '/api/bridge/sessions' && r.method === 'POST').length, 1);
  const send = requests.find((r) => r.method === 'STREAM');
  assert.equal(send.body.slot, 'vscode-demo-abc-1111');
  assert.equal(stream.out[0].md, 'Hello');
  const cards = stream.out.filter((o) => o.part).map((o) => o.part);
  assert.equal(cards[0].toolCallId, 'kc-tool-1');
  assert.equal(cards[0].isComplete, false);
  assert.equal(cards[1].enablePartialUpdate, true, 'the second card updates the first');
  assert.equal(cards[1].isComplete, true);
  assert.deepEqual(cards[1].toolSpecificData.commandLine, { original: 'npm test' });
  assert.equal(cards[1].toolSpecificData.output.text, '12 passing');
  assert.equal(rec.invoked[0].name, 'vscode_get_confirmation_with_options');
  assert.deepEqual(rec.invoked[0].input.buttons, ['Approve', 'Reject']);
  assert.deepEqual(requests.find((r) => r.p === '/api/bridge/approve').body, { slot: 'vscode-demo-abc-1111', requestId: 'req-1', action: 'approved' });
  assert.ok(events.some((e) => e.what === 'approvalAnswered' && e.detail === 'approved:ok'));
  assert.equal(rec.items.get('/vscode-demo-abc-1111').status, 1, 'Completed after the turn');
});

test('approvalResolved from the launcher clears an open card and sends no decision', async () => {
  let cancelled = false;
  let shownResolve;
  const shown = new Promise((r) => (shownResolve = r));
  const invokeTool = (name, opts, tok) =>
    new Promise((resolve, reject) => {
      shownResolve();
      tok.onCancellationRequested(() => {
        cancelled = true;
        reject(new Error('Canceled'));
      });
    });
  const { vscode, rec } = fakeVscode({ invokeTool });
  const requests = [];
  const events = [];
  sessions.register({ subscriptions: [] }, {
    vscode,
    log: () => {},
    chatState: {},
    icon: null,
    postEvent: async (e) => events.push(e),
    promptWithReferences: (r) => r.prompt,
    workspaceFolder: () => 'C:\work\demo',
    request: async (method, p, body) => {
      requests.push({ method, p, body });
      if (p === '/api/bridge/sessions' && method === 'POST') return { session: { slot: 'vscode-demo-abc-2222', folder: body.folder, title: 't', created: 1 } };
      if (p === '/api/bridge/sessions') return { sessions: [] };
      return { ok: true };
    },
    streamChat: async (body, onPart) => {
      onPart({ kind: 'approval', requestId: 'req-7', title: 'Run y', toolKind: 'execute', input: 'y', grant: { granted: true } });
      await shown;
      onPart({ kind: 'approvalResolved', requestId: 'req-7', resolved: 'approved' });
    },
  });
  const out = { out: [], markdown(t) { this.out.push(t); }, push() {} };
  await rec.participants[0].handler({ prompt: 'go', toolInvocationToken: 't' }, draftContext, out, token());
  assert.equal(cancelled, true);
  assert.equal(requests.filter((r) => r.p === '/api/bridge/approve').length, 0);
  assert.ok(out.out.some((t) => /Approved in Kiro Crew/.test(t)));
  assert.ok(events.some((e) => e.what === 'approvalCleared'));
});

test('without the grant the card is replaced by an "approve in Kiro Crew" note', async () => {
  const { rec, stream, requests } = setup({
    parts: [{ kind: 'approval', requestId: 'req-2', title: 'Run z', toolKind: 'execute', input: 'z', grant: { granted: false, cause: 'consent_pending', message: 'the owner has not allowed sessionApproval' } }],
  });
  await rec.participants[0].handler({ prompt: 'go', toolInvocationToken: 't' }, draftContext, stream, token());
  assert.equal(rec.invoked.length, 0);
  assert.equal(requests.filter((r) => r.p === '/api/bridge/approve').length, 0);
  assert.ok(stream.out.some((o) => o.md && /Approval needed in Kiro Crew/.test(o.md) && /sessionApproval/.test(o.md)));
});

test('a rejected confirmation (the card throws) is relayed as rejected', async () => {
  const invokeTool = async () => {
    throw Object.assign(new Error('Canceled'), { name: 'Canceled' });
  };
  const { rec, requests, stream } = setup({ invokeTool, parts: [{ kind: 'approval', requestId: 'req-3', title: 'Run', toolKind: 'execute', input: 'rm', grant: { granted: true } }] });
  await rec.participants[0].handler({ prompt: 'go', toolInvocationToken: 't' }, draftContext, stream, token());
  assert.equal(requests.find((r) => r.p === '/api/bridge/approve').body.action, 'rejected');
});

test('a gateway error ends the turn with a thrown error, which the session view shows', async () => {
  const { rec, stream } = setup({ parts: [{ kind: 'error', text: 'gateway unreachable' }] });
  await assert.rejects(rec.participants[0].handler({ prompt: 'go' }, draftContext, stream, token()), /Kiro Crew: gateway unreachable/);
  assert.equal(rec.items.get('/vscode-demo-abc-1111').status, 0, 'Failed');
});

test('history: provideChatSessionContent rebuilds request and response turns with tool cards', async () => {
  const { rec, events } = setup({
    history: [
      { role: 'user', text: 'read it' },
      { role: 'assistant', parts: [{ kind: 'tool', id: 'c1', title: 'Reading a', state: 'done', toolKind: 'read', input: 'a', output: 'A' }, { kind: 'markdown', text: 'It says A.' }] },
    ],
  });
  const res = await rec.content[0].provider.provideChatSessionContent({ scheme: 'kirocrew', path: '/vscode-demo-abc-1111' });
  assert.equal(res.title, 'old');
  assert.equal(res.history.length, 2);
  assert.equal(res.history[0].prompt, 'read it');
  assert.equal(res.history[0].participant, 'kirocrew');
  assert.equal(res.history[1].response[0].toolCallId, 'c1');
  assert.equal(res.history[1].response[0].isComplete, true);
  assert.equal(res.history[1].response[1].value.value, 'It says A.');
  assert.equal(typeof res.requestHandler, 'function');
  assert.ok(events.some((e) => e.what === 'content' && e.turns === 2));
  const draft = await rec.content[0].provider.provideChatSessionContent({ scheme: 'kirocrew', path: '/untitled-3' });
  assert.deepEqual(draft.history, []);
});

test('commandOf reads a shell command from the tool input', () => {
  assert.equal(sessions.commandOf('{"command":"npm test"}'), 'npm test');
  assert.equal(sessions.commandOf('not json'), '');
  assert.equal(sessions.commandOf(''), '');
});
