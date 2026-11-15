// A minimal stand-in for the Kiro Crew dashboard, served on http://localhost:<port>:
//  - mounts the app's real UI bundle (ui/vscode-pane-*.mjs) as a React component,
//    resolving 'react' from esm.sh and '@kirocrew/app-sdk' to a tiny shim
//  - forwards /apps/vscode-pane/api/* to the launcher's /api/*, signing each
//    request with X-KiroCrew-Proxy exactly like kiro_crew/apps/routes_proxy.py
//  - answers /api/recent-projects
// It also strips cookies on the way to the backend, as the real proxy does.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { signProxyRequest } from '../../backend/lib/auth.mjs';

const SDK_SHIM = `
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
`;

export function createDashboardStandin({ repoRoot, launcherPort, secret, recentDirs = [] }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'app.json'), 'utf8'));
  const entry = path.join(repoRoot, 'ui', manifest.ui.entry);
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>Kiro Crew stand-in</title>
<script type="importmap">${JSON.stringify({
    imports: {
      react: 'https://esm.sh/react@18.3.1',
      'react-dom/client': 'https://esm.sh/react-dom@18.3.1/client',
      '@kirocrew/app-sdk': '/sdk.mjs',
    },
  })}</script></head>
<body style="margin:0;font:13px system-ui;background:#fff;color:#222">
<div style="display:flex;height:100vh"><nav style="width:56px;background:#222"></nav>
<main id="app-host" style="flex:1;display:flex;flex-direction:column;min-width:0"></main></div>
<script type="module">
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '/ui/${manifest.ui.entry}';
createRoot(document.getElementById('app-host')).render(React.createElement(App));
</script></body></html>`;

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    if (url.pathname === '/sdk.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(SDK_SHIM);
    }
    if (url.pathname === `/ui/${manifest.ui.entry}`) {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      return fs.createReadStream(entry).pipe(res);
    }
    if (url.pathname === '/api/recent-projects') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ dirs: recentDirs }));
    }
    const prefix = '/apps/vscode-pane/api/';
    if (url.pathname.startsWith(prefix)) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const target = '/api/' + url.pathname.slice(prefix.length) + url.search;
        const ts = String(Math.floor(Date.now() / 1000));
        const headers = { 'x-kirocrew-proxy': signProxyRequest({ secret, ts, method: req.method, target, body }) };
        if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
        if (body.length) headers['content-length'] = body.length;
        const up = http.request({ host: '127.0.0.1', port: launcherPort, method: req.method, path: target, headers }, (upRes) => {
          res.writeHead(upRes.statusCode, { 'content-type': upRes.headers['content-type'] || 'application/json' });
          upRes.pipe(res);
        });
        up.on('error', () => {
          res.writeHead(502);
          res.end('{"error":"backend unreachable"}');
        });
        up.end(body);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
}
