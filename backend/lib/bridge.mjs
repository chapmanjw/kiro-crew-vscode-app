// Command queue (Kiro Crew -> VS Code) and editor state (VS Code -> Kiro Crew)
// shared between the launcher API and the extension's long poll.
//
// Every VS Code window (one per page tab, see lib/tabs.mjs) runs its own
// extension host, and each host long-polls for its own commands. A command can
// name where it goes (its route):
//   {host}          that extension host only
//   {tab, folder}   the newest window showing that page tab; until a window has
//                   said which tab it is (its Kiro Crew view asks the page), the
//                   newest one with the tab's folder open
//   none            the newest live window (or the first to poll, when none is known)
// A window that was reloaded leaves its old extension host running until the
// server's reconnection grace runs out (remoteExtensionHostAgentServer.ts), so
// "newest" (by when the host started) keeps commands away from those hosts.
// A window knows its tab from the start: the page loads it with ?vscpTab=<id>,
// and the frame proxy hands that to the extension as the default of the
// kiroCrew.paneTab setting (lib/frameproxy.mjs injectConfigurationDefaults).
import { validTabId, sameFolder } from './tabs.mjs';

// A command whose tab has no window yet: it waits for one, until its TTL.
const NOBODY = Symbol('nobody');

export class Bridge {
  constructor({ now = () => Date.now(), connectedWindowMs = 40_000, maxQueue = 100, commandTtlMs = 60_000, liveMs = 60_000 } = {}) {
    this.now = now;
    this.commandTtlMs = commandTtlMs;
    this.expiry = new Map(); // command id -> expiry time; a command older than this is dropped undelivered
    this.connectedWindowMs = connectedWindowMs;
    this.liveMs = liveMs;
    this.maxQueue = maxQueue;
    this.queue = [];
    this.routes = new WeakMap(); // queued command -> its route
    this.waiters = new Set(); // pending long polls: {host, finish}
    this.results = new Map(); // id -> resolve fn
    this.nextId = 1;
    this.lastSeen = 0;
    this.activePolls = 0;
    this.extension = null; // {version, workspaceFolders, ...} from the newest hello
    this.editor = null; // {path, selection, languageId, at}, from whichever window reported last
    this.lastSaved = null; // {path, at}
    this.theme = null; // {signature, applied, error, at} last theme result from the extension
    // The extension host that said hello last.
    this.currentHost = null;
    // Every extension host (one per VS Code window): host -> {folders, tab, at, helloAt, firstAt, startedAt, polls, editor}.
    this.hosts = new Map();
    this.hostTtlMs = 10 * 60 * 1000;
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

  isLive(h) {
    return !!h && (h.polls > 0 || this.now() - h.at < this.liveMs);
  }

  /** The id of the live host started last (by its own start time) among those `pred` accepts, or null. */
  newestHost(pred = () => true) {
    let best = null;
    let bestAt = -1;
    for (const [id, h] of this.hosts) {
      if (!this.isLive(h) || !pred(h)) continue;
      // A host's start, not its latest hello: a lingering host that reconnects must not look new.
      const at = h.startedAt || h.firstAt || 0;
      if (at > bestAt) {
        best = id;
        bestAt = at;
      }
    }
    return best;
  }

  /** Who a command with this route goes to now: a host id, null (whoever polls), or NOBODY (hold it). */
  designee(route) {
    if (!route) return this.newestHost();
    if (route.host) return route.host;
    if (route.tab) {
      const mapped = this.newestHost((h) => h.tab === route.tab);
      if (mapped) return mapped;
      if (route.folder) {
        const byFolder = this.newestHost((h) => !h.tab && h.folders.some((f) => sameFolder(f, route.folder)));
        if (byFolder) return byFolder;
      }
      return NOBODY;
    }
    return this.newestHost();
  }

  deliverable(cmd, host) {
    const d = this.designee(this.routes.get(cmd) || null);
    if (d === NOBODY) return false;
    return d === null || d === host;
  }

  /** The host a page tab's commands go to now, or null. */
  hostForTab(tab) {
    const d = this.designee(tab ? { tab } : null);
    return d === NOBODY ? null : d;
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
  enqueue(command, timeoutMs = 8000, route = null) {
    this.prune();
    const id = String(this.nextId++);
    const entry = { id, ...command };
    const r = normRoute(route);
    if (r) this.routes.set(entry, r);
    this.expiry.set(id, this.now() + this.commandTtlMs);
    if (this.queue.length >= this.maxQueue) this.expiry.delete(this.queue.shift().id);
    this.queue.push(entry);
    const done = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.results.delete(id);
        resolve({ id, ok: false, delivered: !this.queue.includes(entry), timeout: true });
      }, timeoutMs);
      timer.unref?.();
      this.results.set(id, (res) => {
        clearTimeout(timer);
        this.results.delete(id);
        resolve({ id, delivered: true, ...res });
      });
    });
    this.flush();
    return { id, done };
  }

  /** The queued commands `host` may take now, removed from the queue. */
  takeFor(host) {
    const out = [];
    this.queue = this.queue.filter((c) => {
      if (!this.deliverable(c, host)) return true;
      this.expiry.delete(c.id);
      out.push(c);
      return false;
    });
    return out;
  }

  flush() {
    this.prune();
    for (const w of [...this.waiters]) {
      if (!this.queue.length) return;
      const batch = this.takeFor(w.host);
      if (batch.length) w.finish(batch);
    }
  }

  /**
   * Long poll from `host`: returns the commands for it, or waits up to waitMs
   * for one. An aborted signal ends the wait with an empty batch and consumes nothing.
   */
  take(waitMs = 25_000, signal, host = null) {
    const h = host ? String(host).slice(0, 64) : null;
    this.lastSeen = this.now();
    const rec = h ? this.hosts.get(h) : null;
    if (rec) rec.at = this.now();
    this.prune();
    const ready = this.takeFor(h);
    if (ready.length) return Promise.resolve(ready);
    if (signal?.aborted) return Promise.resolve([]);
    this.activePolls++;
    if (rec) rec.polls++;
    return new Promise((resolve) => {
      let finished = false;
      const waiter = { host: h, finish: null };
      const finish = (batch) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        this.waiters.delete(waiter);
        this.activePolls--;
        if (rec && rec.polls > 0) rec.polls--;
        this.lastSeen = this.now();
        if (rec) rec.at = this.now();
        resolve(batch);
      };
      waiter.finish = finish;
      const onAbort = () => finish([]);
      const timer = setTimeout(() => finish([]), waitMs);
      timer.unref?.();
      signal?.addEventListener?.('abort', onAbort);
      this.waiters.add(waiter);
    });
  }

  /**
   * Queue a command that supersedes any queued command of the same kind for
   * the same route (the theme: only the newest matters). Fire and forget.
   */
  enqueueLatest(command, timeoutMs = 8000, route = null) {
    const key = routeKey(normRoute(route));
    this.queue = this.queue.filter((c) => {
      if (c.kind !== command.kind || routeKey(this.routes.get(c) || null) !== key) return true;
      this.expiry.delete(c.id);
      return false;
    });
    return this.enqueue(command, timeoutMs, route);
  }

  /** One copy for every live window (the theme, a tunnel change), or one for the first to poll when none is live. */
  broadcast(command, timeoutMs = 8000) {
    const live = [...this.hosts].filter(([, h]) => this.isLive(h)).map(([id]) => id);
    if (!live.length) return [this.enqueueLatest(command, timeoutMs, null)];
    return live.map((host) => this.enqueueLatest(command, timeoutMs, { host }));
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
    for (const w of [...this.waiters]) w.finish([]);
  }

  hostRecord(host) {
    const id = String(host).slice(0, 64);
    let rec = this.hosts.get(id);
    if (!rec) {
      rec = { folders: [], tab: null, at: this.now(), helloAt: 0, firstAt: 0, startedAt: 0, polls: 0, editor: null };
      this.hosts.set(id, rec);
    }
    return rec;
  }

  /**
   * Apply an event posted by the extension. `fromHost` is the window that sent
   * it (the X-Kiro-Bridge-Host header). Returns false for unknown types.
   */
  applyEvent(ev, fromHost = null) {
    if (!ev || typeof ev !== 'object') return false;
    this.lastSeen = this.now();
    this.events++;
    const at = new Date(this.now()).toISOString();
    const sender = typeof ev.host === 'string' && ev.host ? ev.host.slice(0, 64) : fromHost ? String(fromHost).slice(0, 64) : null;
    switch (ev.type) {
      case 'hello': {
        this.extension = {
          version: str(ev.version),
          workspaceFolders: Array.isArray(ev.workspaceFolders) ? ev.workspaceFolders.map(str).slice(0, 20) : [],
          spawnTracked: ev.spawnTracked === true,
          secretInEnv: ev.secretInEnv === true,
          chat: chatInfo(ev.chat),
          at,
        };
        if (sender) {
          this.currentHost = sender;
          const rec = this.hostRecord(sender);
          rec.folders = this.extension.workspaceFolders;
          rec.at = this.now();
          rec.helloAt = this.now();
          if (!rec.firstAt) rec.firstAt = this.now();
          // When the extension host started (epoch ms, same machine), so the order survives a launcher restart.
          const started = Number(ev.startedAt);
          if (Number.isFinite(started) && started > 0 && started <= this.now() + 60_000) rec.startedAt = started;
          if (ev.tab !== undefined) rec.tab = validTabId(ev.tab);
          this.flush();
        }
        return true;
      }
      case 'tab': {
        // The window's Kiro Crew view asked the page which tab it is in.
        if (!sender) return false;
        const rec = this.hostRecord(sender);
        rec.tab = validTabId(ev.tab);
        rec.at = this.now();
        this.flush();
        return true;
      }
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
      case 'editor': {
        this.editor = ev.path
          ? { path: str(ev.path), languageId: str(ev.languageId), selection: sel(ev.selection), at }
          : null;
        if (sender && this.hosts.has(sender)) this.hosts.get(sender).editor = this.editor;
        return true;
      }
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

  /** Mark a host as alive (it called a bridge route). */
  seeHost(host) {
    const h = host && this.hosts.get(String(host).slice(0, 64));
    if (h) h.at = this.now();
  }

  /**
   * The folders a bridge request may act on: the calling window's own folders
   * when it names its host, else every live window's, else null (no window).
   */
  rootsFor(host) {
    const now = this.now();
    for (const [k, v] of this.hosts) if (v.polls === 0 && now - v.at > this.hostTtlMs) this.hosts.delete(k);
    const own = host && this.hosts.get(String(host).slice(0, 64));
    if (own && own.helloAt) return own.folders;
    const known = [...this.hosts.values()].filter((v) => v.helloAt);
    if (!known.length) return null;
    return [...new Set(known.flatMap((v) => v.folders))];
  }

  /** The extension hosts went away (server restart): forget them until they say hello again. */
  resetConnection() {
    this.cancelWaiters();
    this.lastSeen = 0;
    this.extension = null;
    this.editor = null;
    this.hosts.clear();
    this.currentHost = null;
  }

  /** What GET /api/state reports; with a tab, the active editor is that tab's window's. */
  snapshot(tab = null) {
    this.prune();
    let editor = this.editor;
    if (tab) {
      const host = this.hostForTab(tab);
      editor = host && this.hosts.has(host) ? this.hosts.get(host).editor : null;
    }
    return {
      connected: this.connected,
      extension: this.extension,
      activeEditor: editor,
      lastSaved: this.lastSaved,
      theme: this.theme,
      pendingCommands: this.queue.length,
    };
  }
}

function normRoute(route) {
  if (!route || typeof route !== 'object') return null;
  if (typeof route.host === 'string' && route.host) return { host: route.host.slice(0, 64) };
  if (validTabId(route.tab)) return { tab: route.tab, folder: typeof route.folder === 'string' && route.folder ? route.folder : null };
  return null;
}

function routeKey(r) {
  return r ? (r.host ? `h:${r.host}` : `t:${r.tab}`) : '';
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
