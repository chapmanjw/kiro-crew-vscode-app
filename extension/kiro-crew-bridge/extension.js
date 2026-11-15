// Kiro Crew Bridge: runs in the VS Code server's extension host (Node).
// Long-polls the vscode-pane launcher for commands and posts editor events
// back. The launcher hands us its address and a per-start secret through
// KIROCREW_VSCODE_BRIDGE_URL / KIROCREW_VSCODE_BRIDGE_SECRET, which the
// extension host inherits from the server process.
'use strict';

const vscode = require('vscode');
const http = require('http');

const BRIDGE_URL = process.env.KIROCREW_VSCODE_BRIDGE_URL || '';
const BRIDGE_SECRET = process.env.KIROCREW_VSCODE_BRIDGE_SECRET || '';
const VERSION = require('./package.json').version;

let output;
let statusItem;
let stopped = false;
let connected = false;
let lastError = '';

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
  const uri = vscode.Uri.file(cmd.path);
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
    default:
      throw new Error(`unknown command ${cmd.kind}`);
  }
}

async function pollLoop() {
  let backoff = 1000;
  while (!stopped) {
    try {
      const res = await request('GET', '/api/bridge/commands?wait=25', undefined, 35000);
      if (!connected) {
        setConnected(true);
        log('connected');
        sendHello();
        sendEditor(vscode.window.activeTextEditor);
      }
      backoff = 1000;
      for (const cmd of (res && res.commands) || []) {
        log(`command ${cmd.id} ${cmd.kind} ${cmd.path}`);
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
    workspaceFolders: (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath),
    // Whether this extension host (and so the server process) still carries the
    // gateway's process-tracking variable. A boolean only, never the value.
    spawnTracked: !!process.env.KIROCREW_SPAWN_INSTANCE,
  });
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
  sendHello().then(() => sendEditor(vscode.window.activeTextEditor));
  pollLoop();
}

function deactivate() {
  stopped = true;
}

module.exports = { activate, deactivate };
