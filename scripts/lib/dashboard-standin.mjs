// A minimal stand-in for the Kiro Crew dashboard, served on http://localhost:<port>:
//  - the dashboard's layout around an app page: a nav rail, and a scrolling
//    <main id="main-content"> that the routed page renders into
//  - a tiny router: /apps/vscode-pane[?folder=] mounts the app's real page
//    (ui.entry), /chat shows a composer shelf with the app's session control
//    chip (contributes.sessionControls), mounted like SessionControlHost does
//    with `session.cwd`; navigating away unmounts the page, as App.tsx does
//  - 'react' from esm.sh and '@kirocrew/app-sdk' as a small shim (useAppApi,
//    useTheme, useNavigate, useNotify)
//  - two palettes with the dashboard's token names (design-tokens.css):
//    `dracula-dark` (default) and `light`; window.__standin.setTheme(name) flips
//  - forwards /apps/vscode-pane/api/* to the launcher's /api/*, signing each
//    request with X-KiroCrew-Proxy exactly like kiro_crew/apps/routes_proxy.py,
//    and strips cookies on the way, as the real proxy does
//  - records every POST /apps/vscode-pane/api/theme body (`themePosts`), and
//    answers it with a stub when the launcher has no such route yet
//  - answers /api/recent-projects
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { signProxyRequest } from '../../backend/lib/auth.mjs';

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
`;

// Token names from website/src/styles/design-tokens.css; values: a Dracula-style
// dark palette (John's live theme) and the dashboard's default light palette.
const PALETTES = `
:root,[data-theme="dracula-dark"]{
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
html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font:13px system-ui}
#shell{display:grid;grid-template-columns:64px 1fr;height:100vh}
#rail{margin:8px 0 8px 8px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:16px;display:flex;flex-direction:column;gap:6px;padding:8px 0;align-items:center}
#rail button{width:44px;height:36px;border-radius:10px;border:0;background:transparent;color:var(--muted);cursor:pointer;font:11px system-ui}
#main-content{display:flex;flex-direction:column;min-height:0;min-width:0;overflow-x:hidden;overflow-y:auto}
.chat{margin:8px;flex:1;display:flex;flex-direction:column;justify-content:flex-end;background:var(--bg-elevated);border:1px solid var(--border);border-radius:16px;padding:12px}
.shelf{display:flex;align-items:center;gap:8px;position:relative}
.chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;border:0;background:transparent;color:var(--muted);cursor:pointer;font:12px system-ui}
.popover{position:absolute;bottom:34px;left:0;width:340px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.4)}
`;

export function createDashboardStandin({ repoRoot, launcherPort, secret, recentDirs = [], chatCwd = '' }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'app.json'), 'utf8'));
  const uiDir = path.join(repoRoot, 'ui');
  const control = ((manifest.contributes || {}).sessionControls || [])[0] || null;
  const themePosts = [];
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
<div id="shell"><nav id="rail"><button id="nav-chat" type="button">Chat</button><button id="nav-vscode" type="button">VS Code</button></nav>
<main id="main-content"></main></div>
<script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '/ui/${manifest.ui.entry}';
const h = React.createElement;
const CONTROL = ${JSON.stringify(control ? { entry: control.entryPoint, label: control.label || control.id } : null)};
const CHAT_CWD = ${JSON.stringify(chatCwd)};
let Control = null;
if (CONTROL) Control = (await import('/ui/' + CONTROL.entry)).default;
const listeners = new Set();
window.__standin = {
  navigate(p) { history.pushState(null, '', p); listeners.forEach((f) => f()); },
  setTheme(name) { document.documentElement.dataset.theme = name; },
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
      CONTROL ? h('button', { className: 'chip', 'data-session-control-chip': '', onClick: () => setOpen((o) => !o) }, CONTROL.label) : null,
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
    if (url.pathname === '/' || url.pathname === '/chat' || url.pathname.startsWith('/apps/vscode-pane') && !url.pathname.startsWith('/apps/vscode-pane/api/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
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
  return server;
}
