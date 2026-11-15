// Command queue (Kiro Crew -> VS Code) and editor state (VS Code -> Kiro Crew)
// shared between the launcher API and the extension's long poll.

export class Bridge {
  constructor({ now = () => Date.now(), connectedWindowMs = 40_000, maxQueue = 100, commandTtlMs = 60_000 } = {}) {
    this.now = now;
    this.commandTtlMs = commandTtlMs;
    this.expiry = new Map(); // command id -> expiry time; a command older than this is dropped undelivered
    this.connectedWindowMs = connectedWindowMs;
    this.maxQueue = maxQueue;
    this.queue = [];
    this.waiters = new Set(); // pending long polls
    this.results = new Map(); // id -> resolve fn
    this.nextId = 1;
    this.lastSeen = 0;
    this.activePolls = 0;
    this.extension = null; // {version, pid, workspaceFolders}
    this.editor = null; // {path, selection, languageId, at}
    this.lastSaved = null; // {path, at}
    this.theme = null; // {signature, applied, error, at} last theme result from the extension
    // The extension host that said hello last. After a pane remount or reload
    // the old host lingers until the server's shortened reconnection grace
    // runs out (remoteExtensionHostAgentServer.ts:381-391), so commands go to
    // the newest host only.
    this.currentHost = null;
    this.events = 0;
    // VS Code's "Kiro Crew" webview view as the extension last reported it
    // ({resolved, visible, at}); GET /api/session carries it.
    this.crewView = null;
    this.chatPrefs = null; // {hideCopilotAgents} as the VS Code setting last said
    this.sessionEvents = []; // the last native chat session events (diagnostics)
  }

  get connected() {
    return this.activePolls > 0 || this.now() - this.lastSeen < this.connectedWindowMs;
  }

  /** Drop queued commands past their TTL so a late VS Code does not replay stale requests. */
  prune() {
    const now = this.now();
    if (!this.queue.length) return;
    this.queue = this.queue.filter((c) => {
      const keep = (this.expiry.get(c.id) ?? Infinity) > now;
      if (!keep) this.expiry.delete(c.id);
      return keep;
    });
  }

  /** Queue a command; resolves with the extension's result or {ok:false, timeout:true}. */
  enqueue(command, timeoutMs = 8000) {
    this.prune();
    const id = String(this.nextId++);
    const entry = { id, ...command };
    this.expiry.set(id, this.now() + this.commandTtlMs);
    if (this.queue.length >= this.maxQueue) this.expiry.delete(this.queue.shift().id);
    this.queue.push(entry);
    const done = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.results.delete(id);
        resolve({ id, ok: false, delivered: !this.queue.includes(entry), timeout: true });
      }, timeoutMs);
      timer.unref?.();
      this.results.set(id, (r) => {
        clearTimeout(timer);
        this.results.delete(id);
        resolve({ id, delivered: true, ...r });
      });
    });
    this.flush();
    return { id, done };
  }

  flush() {
    this.prune();
    if (!this.queue.length) return;
    for (const w of this.waiters) {
      this.waiters.delete(w);
      const batch = this.queue.splice(0);
      for (const c of batch) this.expiry.delete(c.id);
      w(batch);
      return;
    }
  }

  /**
   * Long poll: returns queued commands, or waits up to waitMs for one.
   * An aborted signal ends the wait with an empty batch and consumes nothing.
   */
  take(waitMs = 25_000, signal) {
    this.lastSeen = this.now();
    this.prune();
    if (this.queue.length) {
      const batch = this.queue.splice(0);
      for (const c of batch) this.expiry.delete(c.id);
      return Promise.resolve(batch);
    }
    if (signal?.aborted) return Promise.resolve([]);
    this.activePolls++;
    return new Promise((resolve) => {
      let finished = false;
      const finish = (batch) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        this.waiters.delete(finish);
        this.activePolls--;
        this.lastSeen = this.now();
        resolve(batch);
      };
      const onAbort = () => finish([]);
      const timer = setTimeout(() => finish([]), waitMs);
      timer.unref?.();
      signal?.addEventListener?.('abort', onAbort);
      this.waiters.add(finish);
    });
  }

  /**
   * Queue a command that supersedes any queued command of the same kind (the
   * theme: only the newest matters). Fire and forget.
   */
  enqueueLatest(command, timeoutMs = 8000) {
    this.queue = this.queue.filter((c) => {
      if (c.kind !== command.kind) return true;
      this.expiry.delete(c.id);
      return false;
    });
    return this.enqueue(command, timeoutMs);
  }

  /** True when `host` is an older extension host than the one that said hello last. */
  isSuperseded(host) {
    return !!(host && this.currentHost && host !== this.currentHost);
  }

  /** Put undelivered commands back at the front of the queue (with a fresh TTL). */
  requeue(batch) {
    if (batch && batch.length) {
      for (const c of batch) this.expiry.set(c.id, this.now() + this.commandTtlMs);
      this.queue.unshift(...batch);
      this.flush();
    }
  }

  /** Drop waiters (a disconnected client) without losing commands. */
  cancelWaiters() {
    for (const w of [...this.waiters]) w([]);
  }

  /** Apply an event posted by the extension. Returns false for unknown types. */
  applyEvent(ev) {
    if (!ev || typeof ev !== 'object') return false;
    this.lastSeen = this.now();
    this.events++;
    const at = new Date(this.now()).toISOString();
    switch (ev.type) {
      case 'hello':
        this.extension = {
          version: str(ev.version),
          workspaceFolders: Array.isArray(ev.workspaceFolders) ? ev.workspaceFolders.map(str).slice(0, 20) : [],
          spawnTracked: ev.spawnTracked === true,
          secretInEnv: ev.secretInEnv === true,
          chat: chatInfo(ev.chat),
          at,
        };
        if (typeof ev.host === 'string' && ev.host) this.currentHost = ev.host.slice(0, 64);
        return true;
      case 'theme':
        this.theme = {
          signature: str(ev.signature),
          applied: ev.applied === true,
          changed: ev.changed === true,
          error: ev.error ? str(ev.error) : null,
          readBack:
            ev.readBack && typeof ev.readBack === 'object'
              ? { colorTheme: str(ev.readBack.colorTheme), editorBackground: str(ev.readBack.editorBackground), count: Number(ev.readBack.count) || 0 }
              : null,
          at,
        };
        return true;
      case 'editor':
        this.editor = ev.path
          ? { path: str(ev.path), languageId: str(ev.languageId), selection: sel(ev.selection), at }
          : null;
        return true;
      case 'saved':
        this.lastSaved = { path: str(ev.path), at };
        return true;
      case 'crewView':
        this.crewView = { resolved: ev.resolved === true, visible: ev.visible === true, at };
        return true;
      case 'chatPrefs':
        if (typeof ev.hideCopilotAgents !== 'boolean') return false;
        this.chatPrefs = { hideCopilotAgents: ev.hideCopilotAgents, effective: settingsInfo(ev.effective), at };
        return true;
      case 'chatSession': {
        const e = {
          what: str(ev.what),
          slot: ev.slot == null ? null : str(ev.slot),
          turns: Number.isInteger(ev.turns) ? ev.turns : null,
          detail: ev.detail == null ? null : str(ev.detail),
          at,
        };
        this.sessionEvents.push(e);
        if (this.sessionEvents.length > 50) this.sessionEvents.shift();
        return true;
      }
      case 'result': {
        const fn = this.results.get(String(ev.id));
        if (fn) fn({ ok: !!ev.ok, error: ev.error ? str(ev.error) : undefined, ...(typeof ev.value === 'string' ? { value: ev.value.slice(0, 256) } : {}) });
        return true;
      }
      default:
        return false;
    }
  }

  /** The extension host went away (server restart): forget it until it says hello again. */
  resetConnection() {
    this.cancelWaiters();
    this.lastSeen = 0;
    this.extension = null;
    this.editor = null;
  }

  snapshot() {
    this.prune();
    return {
      connected: this.connected,
      extension: this.extension,
      activeEditor: this.editor,
      lastSaved: this.lastSaved,
      theme: this.theme,
      pendingCommands: this.queue.length,
    };
  }
}

function str(v) {
  return typeof v === 'string' ? v.slice(0, 4096) : v == null ? null : String(v).slice(0, 4096);
}

function chatInfo(c) {
  if (!c || typeof c !== 'object') return null;
  return {
    participant: c.participant === true,
    defaultParticipant: c.defaultParticipant === true,
    model: c.model === true,
    modelPublished: c.modelPublished === true,
    sessionType: c.sessionType === true,
    sessionModelPublished: c.sessionModelPublished === true,
    error: c.error ? str(c.error) : null,
  };
}

/** {setting: boolean|null} for the Copilot agent settings the extension reports; anything else dropped. */
function settingsInfo(e) {
  if (!e || typeof e !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(e).slice(0, 10)) {
    if (/^[A-Za-z0-9_.]{1,80}$/.test(k)) out[k] = typeof v === 'boolean' ? v : null;
  }
  return out;
}

function sel(s) {
  if (!s || typeof s !== 'object') return null;
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
  return { startLine: n(s.startLine), startColumn: n(s.startColumn), endLine: n(s.endLine), endColumn: n(s.endColumn) };
}
