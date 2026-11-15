// A minimal stand-in for the Kiro Crew dashboard, served on http://localhost:<port>:
//  - the dashboard's layout around an app page: the 42px top bar row, the nav
//    rail card in its 74px track, and a scrolling, unpadded
//    <main id="main-content"> that the routed page renders into (App.tsx)
//  - a tiny router: /apps/vscode-pane[?folder=] mounts the app's real page
//    (ui.entry), /chat shows a composer shelf with the app's session control
//    chip (contributes.sessionControls), mounted like SessionControlHost does
//    with `session.cwd`; navigating away unmounts the page, as App.tsx does
//  - 'react' from esm.sh and '@kirocrew/app-sdk' as a small shim (useAppApi,
//    useTheme, useNavigate, useNotify)
//  - two palettes with the dashboard's token names (design-tokens.css):
//    `dracula-dark` (default) and `light`; window.__standin.setTheme(name) flips.
//    Any other name (e.g. `plain-light`) defines no tokens at all, for the
//    fallback path where the page cannot read the palette
//  - forwards /apps/vscode-pane/api/* to the launcher's /api/*, signing each
//    request with X-KiroCrew-Proxy exactly like kiro_crew/apps/routes_proxy.py,
//    and strips cookies on the way, as the real proxy does
//  - records every POST /apps/vscode-pane/api/theme body (`themePosts`), and
//    answers it with a stub when the launcher has no such route yet
//  - answers /api/recent-projects
//  - the docked Kiro Crew column's host side: a `ChatPanel` export in the SDK
//    shim that records its props (window.__standinSdk.chatPanel) and opens a
//    body-level picker menu like ChatPage's composer pickers, which
//    window.__standinSdk.setChatPanel(false) removes to show the page's
//    fallback; GET/POST /api/chat/slots and /api/chat/slots/<key>/project
//    (`crewSlots`, `slotPosts`); /icon-192.png from the installed Kiro Crew
//  - the composer's session-control chips drawn the way the host draws them
//    (components/chat-input/ContextShelf.tsx: a wrapper div of
//    <button data-session-control-chip> with an AppIcon lucide <svg
//    class="lucide lucide-<icon>">), both in the /chat view and inside the
//    ChatPanel stub, plus a second app's chip with another icon
//  - the owner's dashboard session: every page load sets an HttpOnly session
//    cookie, and POST /api/auth/mobile-link mints a sign-in link (through the
//    mock gateway's `mintLink`) only for a request that carries it, as the real
//    route needs an authenticated, non-app session (handlers/auth_mobile.py).
//    `server.mobileLink = 'unavailable'` answers 409 external_origin_unavailable
//    (no dashboard URL in Settings); `server.mints` records each call
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { signProxyRequest } from '../../backend/lib/auth.mjs';

const KIROCREW_ICON = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'KiroCrew', 'resources', 'backend-dist', 'kirocrew-backend',
  'Lib', 'site-packages', 'kiro_crew', 'static', 'dist', 'icon-192.png');

const SDK_SHIM = `
import React from 'react';
async function req(method, p, body) {
  const r = await fetch(p, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    const e = new Error('API ' + r.status + ': ' + text);
    e.name = 'AppApiError'; e.status = r.status; e.body = text;
    throw e;
  }
  return text ? JSON.parse(text) : {};
}
const client = {
  get: (p) => req('GET', p),
  post: (p, b) => req('POST', p, b ?? {}),
};
export function useAppApi() { return client; }
export function useNavigate() { return (p) => window.__standin.navigate(p); }
export function useNotify() { return () => {}; }
// Same contract as website/src/app-sdk/index.ts useTheme.
export function useTheme() {
  const read = () => {
    const root = document.documentElement;
    return { mode: root.dataset.theme || 'dark', accent: getComputedStyle(root).getPropertyValue('--accent').trim(), colorTheme: root.dataset.colorTheme || 'default' };
  };
  const [t, setT] = React.useState(read);
  React.useEffect(() => {
    const mo = new MutationObserver(() => setT(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-color-theme', 'style'] });
    return () => mo.disconnect();
  }, []);
  return t;
}

// ChatPanel stand-in: same props as website/src/app-sdk/ChatPanel.tsx
// (slotKey, conversationOnly, expandSteps). It records what it was given and
// draws a transcript, a composer and a model picker whose menu is appended to
// <body> with position:fixed, the way the host's popovers escape their pane.
const sdkState = window.__standinSdk = window.__standinSdk || { chatPanel: { mounts: 0, unmounts: 0, props: [], live: 0 } };
// The composer's app chips as ContextShelf.tsx renders them (see the header).
export function StandinChips({ chips }) {
  const h = React.createElement;
  return h('div', { className: 'chip-row', 'data-testid': 'chip-row' },
    chips.map((c) => h('button', { key: c.id, type: 'button', className: 'chip', 'data-session-control-chip': '', title: c.label, 'aria-label': c.label, 'data-chip-id': c.id, onClick: c.onClick },
      h('svg', { className: 'lucide lucide-' + c.icon, width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'aria-hidden': 'true' }, h('rect', { x: 4, y: 4, width: 16, height: 16, rx: 2 })),
      h('span', null, c.label))));
}
window.__standinChips = window.__standinChips || [];
function ChatPanelStub(props) {
  const btn = React.useRef(null);
  const [menu, setMenu] = React.useState(false);
  React.useEffect(() => {
    sdkState.chatPanel.mounts++;
    sdkState.chatPanel.live++;
    return () => { sdkState.chatPanel.unmounts++; sdkState.chatPanel.live--; };
  }, []);
  React.useEffect(() => {
    sdkState.chatPanel.props.push({ ...props });
  }, [props.slotKey, props.conversationOnly, props.expandSteps]);
  React.useEffect(() => {
    if (!menu || !btn.current) return undefined;
    const b = btn.current.getBoundingClientRect();
    const el = document.createElement('div');
    el.setAttribute('data-testid', 'stub-picker-menu');
    el.setAttribute('role', 'menu');
    Object.assign(el.style, { position: 'fixed', zIndex: '50', width: '260px', height: '180px', left: Math.max(4, b.right - 260) + 'px', top: Math.max(4, b.top - 184) + 'px',
      background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,.4)', color: 'var(--text)', padding: '6px', boxSizing: 'border-box' });
    el.textContent = 'claude-opus (stub model menu)';
    document.body.appendChild(el);
    return () => el.remove();
  }, [menu]);
  const h = React.createElement;
  return h('div', { 'data-testid': 'crew-chatpanel-stub', 'data-slot': props.slotKey, 'data-conversation-only': String(!!props.conversationOnly),
    style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    h('div', { style: { flex: '1 1 auto', padding: '12px', overflow: 'auto', fontSize: '13px' } },
      h('div', { style: { color: 'var(--muted)', marginBottom: '8px' } }, 'ChatPage stub'),
      h('div', { style: { background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: '12px', padding: '8px 10px', marginBottom: '8px' } }, 'Session ' + props.slotKey),
      h('div', { style: { padding: '4px 2px' } }, 'Hello from the Kiro Crew stand-in. Tool cards, approvals and the composer render here in the real host.')),
    h('div', { style: { flex: 'none', margin: '8px', border: '1px solid var(--border)', borderRadius: '12px', background: 'var(--bg-elevated)', padding: '8px' } },
      h('textarea', { 'aria-label': 'Message', placeholder: 'Message Kiro Crew', rows: 2, style: { width: '100%', boxSizing: 'border-box', resize: 'none', background: 'transparent', color: 'var(--text)', border: 0, outline: 'none', font: 'inherit' } }),
      h('div', { style: { display: 'flex', gap: '6px', justifyContent: 'flex-end' } },
        h(StandinChips, { chips: window.__standinChips }),
        h('button', { ref: btn, type: 'button', 'data-testid': 'stub-picker', onClick: () => setMenu((m) => !m),
          style: { height: '24px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)', font: '12px system-ui' } }, 'Model'))));
}
// A live binding, so setChatPanel(false) removes the export the way an older host lacks it.
export let ChatPanel = ChatPanelStub;
sdkState.setChatPanel = (on) => { ChatPanel = on ? ChatPanelStub : undefined; };
`;

// Token names from website/src/styles/design-tokens.css; values: a Dracula-style
// dark palette (John's live theme) and the dashboard's default light palette.
const PALETTES = `
[data-theme="dracula-dark"]{
  --bg:#21222c;--bg-accent:#232530;--bg-elevated:#282a36;--bg-hover:#343746;
  --card:#262833;--card-fg:#f8f8f2;--panel:#21222c;--panel-strong:#282a36;
  --text:#f8f8f2;--text-strong:#ffffff;--muted:#a3a6c4;--muted-strong:#6272a4;
  --border:#3a3d4e;--border-strong:#4d5066;--border-hover:#6272a4;
  --accent:#bd93f9;--accent-fg:#000;--accent-hover:#caa9fa;--accent-subtle:rgba(189,147,249,.2);--ring:#bd93f9;
  --ok:#50fa7b;--warn:#f1fa8c;--danger:#ff5555;--info:#8be9fd;
  --diff-add:rgba(80,250,123,.15);--diff-add-text:#50fa7b;--diff-del:rgba(255,85,85,.15);--diff-del-text:#ff5555;
  --search-highlight:color-mix(in srgb, #ffb86c 45%, transparent);
  --radius-sm:6px;--radius-md:8px;--radius-lg:12px;--radius-xl:16px;--shadow-sm:0 1px 2px rgba(0,0,0,.2);
}
[data-theme="light"]{
  --bg:#fafafa;--bg-accent:#f5f5f5;--bg-elevated:#ffffff;--bg-hover:#f0f0f0;
  --card:#ffffff;--card-fg:#18181b;--panel:#fafafa;--panel-strong:#f5f5f5;
  --text:#27272a;--text-strong:#09090b;--muted:#6b6b73;--muted-strong:#a1a1aa;
  --border:#e4e4e7;--border-strong:#d4d4d8;--border-hover:#a1a1aa;
  --accent:#047558;--accent-fg:#fff;--accent-hover:#065f46;--accent-subtle:rgba(4,117,88,.12);--ring:#10b981;
  --ok:#15803d;--warn:#a16207;--danger:#dc2626;--info:#0e7490;
  --diff-add:rgba(46,160,67,.15);--diff-add-text:#116329;--diff-del:rgba(248,81,73,.15);--diff-del-text:#82071e;
  --radius-sm:6px;--radius-md:8px;--radius-lg:12px;--radius-xl:16px;--shadow-sm:0 1px 2px rgba(0,0,0,.06);
}
html,body{margin:0;height:100%;background:var(--bg,#808080);color:var(--text,#000);font:13px system-ui}
/* The shell grid of website/src/App.tsx: a 42px top bar row over the content
   row (grid-rows-[42px_minmax(0,1fr)]), the rail track 74px wide when collapsed
   (hooks/useRailWidth.ts RAIL_W_COLLAPSED), the rail card \`mx-2 mt-0 mb-2\` with
   rounded-xl and a 1px border (shell/nav/navRail.tsx), and <main> with no padding. */
#shell{display:grid;grid-template-rows:42px minmax(0,1fr);grid-template-columns:74px minmax(0,1fr);height:100vh}
/* The expanded sidebar: the same <nav> in a 236px track (RAIL_W_EXPANDED). */
#shell[data-nav="expanded"]{grid-template-columns:236px minmax(0,1fr)}
#topbar{grid-column:1 / -1;display:flex;align-items:center;padding:0 12px;color:var(--muted)}
#rail{margin:0 8px 8px 8px;min-width:0;background:var(--bg-elevated);border:1px solid var(--border);border-radius:16px;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--shadow-sm)}
/* navRail.tsx:149-154: \`shrink-0 flex flex-col gap-0.5 px-2 pt-2\` holding the
   brand row (railChrome.tsx: \`mb-1.5\`, a w-7 h-7 logo expanded, w-9 h-9 + mt-1
   collapsed) and, expanded only, the \`h-px bg-border mb-[7px]\` hairline. */
#rail-head{flex:none;display:flex;flex-direction:column;gap:2px;padding:8px 8px 0}
#rail-brand{display:flex;align-items:center;gap:10px;margin-bottom:6px;color:var(--muted);font:700 13px system-ui;letter-spacing:.14em;white-space:nowrap;overflow:hidden}
#rail-logo{flex:none;width:36px;height:36px;margin-top:4px;border-radius:10px;background:var(--accent)}
#rail-brand span{display:none}
#rail-hairline{display:none;height:1px;background:var(--border);margin-bottom:7px}
#shell[data-nav="expanded"] #rail-logo{width:28px;height:28px;margin-top:0}
#shell[data-nav="expanded"] #rail-brand span{display:inline}
#shell[data-nav="expanded"] #rail-hairline{display:block}
#rail-items{display:flex;flex-direction:column;gap:6px;align-items:center;padding:8px 0}
#rail button{width:44px;height:36px;border-radius:10px;border:0;background:transparent;color:var(--muted);cursor:pointer;font:11px system-ui}
#shell[data-nav="expanded"] #rail-items{align-items:stretch;padding:0 8px}
#shell[data-nav="expanded"] #rail button{width:auto;text-align:left;padding:0 10px}
#main-content{display:flex;flex-direction:column;min-height:0;min-width:0;padding:0;overflow-x:hidden;overflow-y:auto}
.chat{margin:8px;flex:1;display:flex;flex-direction:column;justify-content:flex-end;background:var(--bg-elevated);border:1px solid var(--border);border-radius:16px;padding:12px}
.shelf{display:flex;align-items:center;gap:8px;position:relative}
.chip-row{display:flex;align-items:center;gap:8px;padding-right:8px;border-right:1px solid var(--border)}
.chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;border:0;background:transparent;color:var(--muted);cursor:pointer;font:12px system-ui}
.popover{position:absolute;bottom:34px;left:0;width:340px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.4)}
`;

export function createDashboardStandin({ repoRoot, launcherPort, secret, recentDirs = [], chatCwd = '', mintLink = null }) {
  const SESSION = `standin-${Math.random().toString(36).slice(2)}`;
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'app.json'), 'utf8'));
  const uiDir = path.join(repoRoot, 'ui');
  const control = ((manifest.contributes || {}).sessionControls || [])[0] || null;
  const themePosts = [];
  const slotPosts = [];
  const crewSlots = [];
  const page = `<!doctype html><html data-theme="dracula-dark"><head><meta charset="utf-8"><title>Kiro Crew stand-in</title>
<style>${PALETTES}</style>
<script type="importmap">${JSON.stringify({
    imports: {
      react: 'https://esm.sh/react@18.3.1',
      'react-dom/client': 'https://esm.sh/react-dom@18.3.1/client',
      '@kirocrew/app-sdk': '/sdk.mjs',
    },
  })}</script></head>
<body>
<div id="shell"><header id="topbar">Kiro Crew</header><nav id="rail"><div id="rail-head"><div id="rail-brand"><i id="rail-logo"></i><span>KIRO CREW</span></div><div id="rail-hairline"></div></div><div id="rail-items"><button id="nav-chat" type="button">Chat</button><button id="nav-vscode" type="button">VS Code</button></div></nav>
<main id="main-content"></main></div>
<script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '/ui/${manifest.ui.entry}';
import { StandinChips } from '@kirocrew/app-sdk';
const h = React.createElement;
const CONTROL = ${JSON.stringify(control ? { entry: control.entryPoint, label: control.label || control.id, icon: control.icon || 'Package' } : null)};
const kebab = (n) => String(n).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
// This app's chip and another app's, in manifest order, as the host lists them.
window.__standinChips = [
  ...(CONTROL ? [{ id: 'vscode-pane:' + 'control', label: CONTROL.label, icon: kebab(CONTROL.icon) }] : []),
  { id: 'other-app:control', label: 'Other app', icon: 'zap' },
];
const CHAT_CWD = ${JSON.stringify(chatCwd)};
let Control = null;
if (CONTROL) Control = (await import('/ui/' + CONTROL.entry)).default;
const listeners = new Set();
window.__standin = {
  navigate(p) { history.pushState(null, '', p); listeners.forEach((f) => f()); },
  setTheme(name) { document.documentElement.dataset.theme = name; },
  setNav(mode) { document.getElementById('shell').dataset.nav = mode; },
  mounts: 0, unmounts: 0,
};
window.addEventListener('popstate', () => listeners.forEach((f) => f()));
function useRoute() {
  const [, set] = React.useState(0);
  React.useEffect(() => { const f = () => set((n) => n + 1); listeners.add(f); return () => listeners.delete(f); }, []);
  return location.pathname;
}
function Counted() {
  React.useEffect(() => { window.__standin.mounts++; return () => { window.__standin.unmounts++; }; }, []);
  return h(App);
}
function Chat() {
  const [open, setOpen] = React.useState(false);
  return h('div', { className: 'chat' },
    h('div', { className: 'shelf', 'data-testid': 'composer-context-shelf' },
      h(StandinChips, { chips: window.__standinChips.map((c, i) => (i === 0 && CONTROL ? { ...c, onClick: () => setOpen((o) => !o) } : c)) }),
      h('span', { className: 'chip' }, 'Ultra Mode'),
      h('span', { className: 'chip' }, 'project'),
      open && Control ? h('div', { className: 'popover', role: 'dialog' },
        h(Control, { session: { sessionKey: 'dashboard:chat-1', folderId: '', cwd: CHAT_CWD }, onClose: () => setOpen(false) })) : null));
}
function Root() {
  const route = useRoute();
  // One <Route> per path, as in App.tsx: leaving the app route unmounts the page.
  return route.startsWith('/apps/vscode-pane') || route === '/' ? h(Counted) : h(Chat);
}
document.getElementById('nav-chat').onclick = () => window.__standin.navigate('/chat');
document.getElementById('nav-vscode').onclick = () => window.__standin.navigate('/apps/vscode-pane');
createRoot(document.getElementById('main-content')).render(h(Root));
</script></body></html>`;

  const forward = (req, res, url, body, onDone) => {
    const prefix = '/apps/vscode-pane/api/';
    const target = '/api/' + url.pathname.slice(prefix.length) + url.search;
    const ts = String(Math.floor(Date.now() / 1000));
    const headers = { 'x-kirocrew-proxy': signProxyRequest({ secret, ts, method: req.method, target, body }) };
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    if (body.length) headers['content-length'] = body.length;
    const up = http.request({ host: '127.0.0.1', port: launcherPort, method: req.method, path: target, headers }, (upRes) => {
      if (onDone && onDone(upRes)) return;
      res.writeHead(upRes.statusCode, { 'content-type': upRes.headers['content-type'] || 'application/json' });
      upRes.pipe(res);
    });
    up.on('error', () => {
      res.writeHead(502);
      res.end('{"error":"backend unreachable"}');
    });
    up.end(body);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/auth/mobile-link' && req.method === 'POST') {
      req.resume();
      const hasCookie = new RegExp(`(?:^|;\\s*)standin_session=${SESSION}(?:;|$)`).test(req.headers.cookie || '');
      const json = (status, v) => {
        server.mints.push({ status, cookie: hasCookie, origin: req.headers.origin || null });
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(v));
      };
      if (!hasCookie) return json(401, { error: 'unauthenticated', code: 'unauthenticated' });
      if (server.mobileLink === 'unavailable' || !mintLink) return json(409, { error: 'external_origin_unavailable', code: 'external_origin_unavailable' });
      return json(200, { url: mintLink(), expires_in: 300 });
    }
    if (url.pathname === '/' || url.pathname === '/chat' || url.pathname.startsWith('/apps/vscode-pane') && !url.pathname.startsWith('/apps/vscode-pane/api/')) {
      // The owner's dashboard session, as the gateway sets mc_token_<port>.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `standin_session=${SESSION}; HttpOnly; SameSite=Lax; Path=/` });
      return res.end(page);
    }
    if (url.pathname === '/sdk.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(SDK_SHIM);
    }
    if (url.pathname.startsWith('/ui/')) {
      const rel = decodeURIComponent(url.pathname.slice(4));
      const file = path.resolve(uiDir, rel);
      if (!file.startsWith(uiDir + path.sep) || !fs.existsSync(file)) {
        res.writeHead(404);
        return res.end();
      }
      const type = file.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript';
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    if (url.pathname === '/icon-192.png') {
      if (!fs.existsSync(KIROCREW_ICON)) {
        res.writeHead(404);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      return fs.createReadStream(KIROCREW_ICON).pipe(res);
    }
    if (url.pathname === '/api/chat/slots' || url.pathname.startsWith('/api/chat/slots/')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body = null;
        try {
          body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        } catch {
          /* recorded as null */
        }
        const json = (status, v) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(v));
        };
        if (req.method === 'GET' && url.pathname === '/api/chat/slots') return json(200, crewSlots);
        if (req.method === 'POST' && url.pathname === '/api/chat/slots') {
          slotPosts.push({ path: url.pathname, body });
          const name = body && body.name;
          let row = crewSlots.find((s) => s.key === name);
          if (!row && name) crewSlots.push((row = { key: name, title: body.title || name, messages: 0, running: false }));
          return json(row ? 200 : 400, row ? { key: row.key, project: row.project } : { error: 'name required' });
        }
        const m = /^\/api\/chat\/slots\/([^/]+)\/project$/.exec(url.pathname);
        if (req.method === 'POST' && m) {
          slotPosts.push({ path: url.pathname, body });
          const row = crewSlots.find((s) => s.key === decodeURIComponent(m[1]));
          if (row && body) row.project = body.project;
          return json(row ? 200 : 404, row || { error: 'no such slot' });
        }
        return json(404, { error: 'not in the stand-in' });
      });
      return;
    }
    if (url.pathname === '/api/recent-projects') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ dirs: recentDirs }));
    }
    if (url.pathname.startsWith('/apps/vscode-pane/api/')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (url.pathname === '/apps/vscode-pane/api/theme' && req.method === 'POST') {
          let parsed = null;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            /* recorded as null */
          }
          themePosts.push({ at: Date.now(), body: parsed });
          // Forward to the launcher; a launcher without the route gets a stub reply.
          return forward(req, res, url, body, (upRes) => {
            if (upRes.statusCode < 400) return false;
            upRes.resume();
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true,"stub":true}');
            return true;
          });
        }
        forward(req, res, url, body);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.themePosts = themePosts;
  server.slotPosts = slotPosts;
  server.crewSlots = crewSlots;
  server.mobileLink = 'ok';
  server.mints = [];
  // A restarted backend listens on a new port, as the gateway's proxy would
  // follow it; the page keeps calling the same /apps/vscode-pane/api/ URLs.
  server.setLauncherPort = (p) => {
    launcherPort = p;
  };
  return server;
}
