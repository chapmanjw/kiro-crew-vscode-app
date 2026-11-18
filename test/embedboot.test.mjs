// The embed bootstrap (backend/lib/embedboot.mjs), run the way the browser runs it: in the embed
// page's own scope, with that page's location, window, sessionStorage, history and timers. Each
// page here stands for one load of one Kiro Crew view. The `shared` object stands for the
// sessionStorage data that all the views of one dashboard tab share, and `name` for the view's
// window.name, which belongs to its frame and survives the frame's own page loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { EMBED_BOOT_PATH, EMBED_BOOT_SOURCE, embedBootTag, insertHeadTag, isEmbedPath } from '../backend/lib/embedboot.mjs';

const TABS = 'kirocrew-embed-tabs';
const INDEX = 'kirocrew-embed-active-index';
const SAVED = 'vscp-kc-view:';
const json = (v) => JSON.stringify(v);

function page(url, { shared = {}, name = '', blocked = false } = {}) {
  const u = new URL(url, 'http://tunnel.test');
  class Storage {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
    }
    setItem(key, value) {
      this.data[key] = String(value);
    }
  }
  const sessionStorage = new Storage();
  sessionStorage.data = shared;
  const calls = [];
  const timers = [];
  const listeners = {};
  const location = { pathname: u.pathname, search: u.search, href: u.href, replace: (to) => calls.push(['replace', to]) };
  const history = { pushState: (s, t, to) => calls.push(['push', to]), replaceState: (s, t, to) => calls.push(['replaceState', to]) };
  const window = { name, addEventListener: (type, fn) => (listeners[type] ||= []).push(fn) };
  Object.defineProperty(window, 'sessionStorage', {
    get() {
      if (blocked) throw new Error('blocked');
      return sessionStorage;
    },
  });
  const setTimeout = (fn, ms) => timers.push([fn, ms]);
  const scope = { Storage, window, location, history, URL, URLSearchParams, Uint8Array, JSON, Number, Array, String, Object, decodeURIComponent, crypto: webcrypto, setTimeout };
  vm.runInContext(EMBED_BOOT_SOURCE, vm.createContext(scope));
  /** Run the timers due within `ms`, in order, as the browser would. */
  const run = (ms) => {
    for (const t of timers.splice(0)) (t[1] <= ms ? t[0]() : timers.push(t));
  };
  const fire = (type) => (listeners[type] || []).forEach((fn) => fn());
  const tabs = () => ({ tabs: JSON.parse(sessionStorage.getItem(TABS)), index: Number(sessionStorage.getItem(INDEX)) });
  return { sessionStorage, Storage, window, history, calls, timers, run, fire, tabs, shared };
}

test('a chat page answers with its own chat as the only tab, active', () => {
  const p = page('/embed/chat/chat-692-1?sid=chat-692-1', { shared: { [TABS]: json(['chat-696']), [INDEX]: '1' } });
  assert.deepEqual(p.tabs(), { tabs: ['chat-692-1'], index: 0 });
});

test('the chat is named by ?sid=, since the path carries a title slug once the embed has rewritten it', () => {
  assert.deepEqual(page('/embed/chat/vs-code-my-app?sid=vscode-my-app-23c6').tabs(), { tabs: ['vscode-my-app-23c6'], index: 0 });
  assert.deepEqual(page('/embed/chat/chat-5').tabs(), { tabs: ['chat-5'], index: 0 }, 'with no sid the path names it');
  assert.deepEqual(page('/embed/chat/chat%203?sid=').tabs(), { tabs: ['chat 3'], index: 0 }, 'an empty sid is ignored');
});

test("the session list page answers with the list tab, never another view's chat", () => {
  const p = page('/embed/sessions', { shared: { [TABS]: json(['chat-696']), [INDEX]: '0' } });
  assert.deepEqual(p.tabs(), { tabs: [''], index: 0 });
  assert.deepEqual(page('/embed/sessions/').tabs(), { tabs: [''], index: 0 }, 'a trailing slash is the same page');
});

test('each view has its own tabs: two views on one shared storage never see each other, and the shared keys stay unwritten', () => {
  const shared = {};
  const a = page('/embed/chat/chat-1?sid=chat-1', { shared });
  const b = page('/embed/sessions', { shared });
  a.sessionStorage.setItem(TABS, json(['chat-1', 'chat-2']));
  a.sessionStorage.setItem(INDEX, '1');
  assert.deepEqual(a.tabs(), { tabs: ['chat-1', 'chat-2'], index: 1 });
  assert.deepEqual(b.tabs(), { tabs: [''], index: 0 }, 'the other view is untouched');
  assert.notEqual(a.window.name, b.window.name);
  assert.match(a.window.name, /^vscp-kc:[0-9a-f]{16}$/);
  assert.equal(TABS in shared || INDEX in shared, false);
});

test('window.name holds only an id; the tabs are in sessionStorage under it', () => {
  const p = page('/embed/chat/chat-1?sid=chat-1');
  const id = p.window.name.slice('vscp-kc:'.length);
  assert.equal(p.window.name.includes('chat-1'), false);
  assert.deepEqual(JSON.parse(p.shared[SAVED + id]), { tabs: ['chat-1'], index: 0 });
});

test("a reload of the same view restores its tabs, and the selected tab follows the page", () => {
  const shared = {};
  const first = page('/embed/chat/chat-1?sid=chat-1', { shared });
  first.sessionStorage.setItem(TABS, json(['chat-1', '', 'chat-2']));
  first.sessionStorage.setItem(INDEX, '1');
  const name = first.window.name;
  assert.deepEqual(page('/embed/sessions', { shared, name }).tabs(), { tabs: ['chat-1', '', 'chat-2'], index: 1 }, 'the list page keeps the selected Sessions tab');
  assert.deepEqual(page('/embed/chat/vs-title?sid=chat-2', { shared, name }).tabs(), { tabs: ['chat-1', '', 'chat-2'], index: 2 });
  assert.deepEqual(page('/embed/chat/chat-1?sid=chat-1', { shared, name }).tabs(), { tabs: ['chat-1', '', 'chat-2'], index: 0 });
});

test('a page that is not among the saved tabs starts from its own, and unsound saved state is ignored', () => {
  const shared = {};
  const first = page('/embed/chat/chat-1?sid=chat-1', { shared });
  const name = first.window.name;
  assert.deepEqual(page('/embed/chat/chat-9?sid=chat-9', { shared, name }).tabs(), { tabs: ['chat-9'], index: 0 });
  const id = name.slice('vscp-kc:'.length);
  for (const bad of ['not json', json({ tabs: 'x', index: 0 }), json({ tabs: [], index: 0 }), json({ tabs: ['a'], index: 3 }), json({ tabs: [5], index: 0 }), json({ tabs: ['x'.repeat(301)], index: 0 })]) {
    shared[SAVED + id] = bad;
    assert.deepEqual(page('/embed/chat/chat-1?sid=chat-1', { shared, name }).tabs(), { tabs: ['chat-1'], index: 0 }, bad.slice(0, 30));
  }
});

test("the embed's writes are checked: only a sound list and an index inside it are taken", () => {
  const p = page('/embed/chat/chat-1?sid=chat-1');
  p.sessionStorage.setItem(TABS, json(['a', 'b', 'c']));
  p.sessionStorage.setItem(INDEX, '2');
  p.sessionStorage.setItem(INDEX, '9');
  p.sessionStorage.setItem(INDEX, 'x');
  assert.deepEqual(p.tabs(), { tabs: ['a', 'b', 'c'], index: 2 });
  for (const bad of ['[]', 'nope', json([1]), json(Array.from({ length: 51 }, (_, i) => `t${i}`)), json(['x'.repeat(301)])]) p.sessionStorage.setItem(TABS, bad);
  assert.deepEqual(p.tabs(), { tabs: ['a', 'b', 'c'], index: 2 });
  p.sessionStorage.setItem(TABS, json(['a']));
  assert.deepEqual(p.tabs(), { tabs: ['a'], index: 0 }, 'the index follows a shorter list');
});

test('other keys, other storages and pages that are not a chat or the list pass through untouched', () => {
  const p = page('/embed/chat/chat-1?sid=chat-1', { shared: { other: 'x' } });
  assert.equal(p.sessionStorage.getItem('other'), 'x');
  assert.equal(p.sessionStorage.getItem('missing'), null);
  p.sessionStorage.setItem('mine', '1');
  assert.equal(p.shared.mine, '1');
  const local = new p.Storage();
  local.data = { [TABS]: json(['mine']) };
  assert.equal(local.getItem(TABS), json(['mine']), 'a storage that is not the session storage is not answered for');
  for (const url of ['/embed/settings', '/embed', '/embed/chat/', '/embed/chat/a/b']) {
    const q = page(url, { shared: { [TABS]: json(['x']) } });
    assert.equal(q.sessionStorage.getItem(TABS), json(['x']), url);
    assert.equal(q.window.name, '', `${url} claims no name`);
  }
});

test('a window name that is not ours is left alone; the page still answers for itself, and nothing is saved', () => {
  const p = page('/embed/chat/chat-1?sid=chat-1', { name: 'somebody-else' });
  assert.equal(p.window.name, 'somebody-else');
  assert.deepEqual(p.tabs(), { tabs: ['chat-1'], index: 0 });
  assert.deepEqual(Object.keys(p.shared), []);
  const q = page('/embed/sessions', { name: 'vscp-kc:not-an-id' });
  assert.equal(q.window.name, 'vscp-kc:not-an-id');
  assert.deepEqual(q.tabs(), { tabs: [''], index: 0 });
});

test('with the session storage blocked, the bootstrap does not throw and the embed keeps its own behaviour', () => {
  assert.doesNotThrow(() => page('/embed/chat/chat-1?sid=chat-1', { blocked: true }));
  const p = page('/embed/sessions', { blocked: true });
  p.history.pushState(null, '', '/embed/chat/x');
  assert.deepEqual(p.calls, [['push', '/embed/chat/x']]);
});

test('a move from a chat page to the session list is held back, and the list page loads again instead', () => {
  const p = page('/embed/chat/chat-1?sid=chat-1');
  p.history.pushState(null, '', '/embed/sessions');
  assert.deepEqual(p.calls, [], 'the page does not move itself');
  p.run(0);
  assert.deepEqual(p.calls, [['replace', '/embed/sessions']]);
});

test("the strip's own saves land before the page freezes, and nothing after them changes what it saved", () => {
  const p = page('/embed/chat/chat-1?sid=chat-1');
  p.history.pushState(null, '', '/embed/sessions');
  p.sessionStorage.setItem(TABS, json(['', 'chat-2']));
  p.sessionStorage.setItem(INDEX, '0');
  p.fire('kirocrew-tab-update');
  p.sessionStorage.setItem(TABS, json(['chat-1']));
  p.sessionStorage.setItem(INDEX, '0');
  p.history.pushState(null, '', '/embed/chat/chat-1?sid=chat-1');
  p.history.replaceState(null, '', '/embed/chat/chat-1?sid=chat-1');
  assert.deepEqual(p.tabs(), { tabs: ['', 'chat-2'], index: 0 });
  const id = p.window.name.slice('vscp-kc:'.length);
  assert.deepEqual(JSON.parse(p.shared[SAVED + id]), { tabs: ['', 'chat-2'], index: 0 });
  assert.deepEqual(p.calls, []);
  p.run(0);
  assert.deepEqual(p.calls, [['replace', '/embed/sessions']]);
});

test('without the strip\'s event the page still freezes shortly after, and a second move schedules nothing more', () => {
  const p = page('/embed/chat/chat-1?sid=chat-1');
  p.history.pushState(null, '', '/embed/sessions');
  p.history.pushState(null, '', '/embed/sessions?x=1');
  assert.equal(p.timers.filter((t) => t[1] === 0).length, 1, 'one load of the list page');
  p.run(50);
  p.sessionStorage.setItem(TABS, json(['late']));
  p.history.replaceState(null, '', '/x');
  assert.deepEqual(p.calls, [['replace', '/embed/sessions']]);
  assert.deepEqual(p.tabs(), { tabs: ['chat-1'], index: 0 });
  p.run(5000);
  p.history.replaceState(null, '', '/y');
  assert.deepEqual(p.calls.at(-1), ['replaceState', '/y'], 'the freeze lifts if the page is still there after five seconds');
});

test('moves that are not a chat page going to the list pass through, replaceState included', () => {
  const list = page('/embed/sessions');
  list.history.pushState(null, '', '/embed/sessions');
  list.history.replaceState(null, '', '/embed/sessions');
  list.history.pushState(null, '', '/embed/chat/chat-2?sid=chat-2');
  assert.deepEqual(list.calls, [['push', '/embed/sessions'], ['replaceState', '/embed/sessions'], ['push', '/embed/chat/chat-2?sid=chat-2']]);
  const chat = page('/embed/chat/chat-1?sid=chat-1');
  chat.history.pushState(null, '', '/embed/chat/chat-2?sid=chat-2');
  chat.history.replaceState(null, '', '/embed/sessions');
  chat.history.pushState(null, '', null);
  assert.deepEqual(chat.calls, [['push', '/embed/chat/chat-2?sid=chat-2'], ['replaceState', '/embed/sessions'], ['push', null]]);
  assert.deepEqual(chat.timers, [], 'nothing was scheduled');
});

test('the tunnel adds the bootstrap to the embed pages only, as one script tag with a fixed path', () => {
  assert.equal(EMBED_BOOT_PATH, '/_vscp-kc/embed.js');
  assert.equal(embedBootTag(), '<script src="/_vscp-kc/embed.js"></script>');
  for (const p of ['/embed', '/embed/', '/embed/sessions', '/embed/chat/chat-1']) assert.equal(isEmbedPath(p), true, p);
  for (const p of ['/', '/embedded', '/api/embed', '/apps/vscode-pane', '', null]) assert.equal(isEmbedPath(p), false, String(p));
});

test('insertHeadTag puts the tag just before </head>, in any case, or in front of a page with no head', () => {
  const tag = '<script src="x"></script>';
  assert.equal(insertHeadTag('<html><head><title>t</title></head><body></body></html>', tag), `<html><head><title>t</title>${tag}</head><body></body></html>`);
  assert.equal(insertHeadTag('<HTML><HEAD></HEAD></HTML>', tag), `<HTML><HEAD>${tag}</HEAD></HTML>`);
  assert.equal(insertHeadTag('<body></body>', tag), `${tag}<body></body>`);
});
