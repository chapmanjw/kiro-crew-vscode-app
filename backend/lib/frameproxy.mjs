// Reverse proxy from the launcher port to the VS Code server, HTTP and
// WebSocket, under an unguessable path prefix.
//
// Why a proxy: the server's connection token travels as a `vscode-tkn` cookie
// with SameSite=Lax (vscode/src/vs/server/node/webClientServer.ts:336-359,
// 508-519). The dashboard runs on http://localhost:<port> and the frame on
// http://127.0.0.1:<port>, which are different sites, so the browser neither
// stores nor sends that cookie inside the frame and every request after the
// first redirect fails. The proxy adds the token cookie to each forwarded
// request and writes the token into the workbench config (see
// injectConnectionToken) for the WebSocket auth handshake. It also drops every
// cookie the browser sends, so no dashboard cookie can reach VS Code.

import http from 'node:http';
import net from 'node:net';
import { clientHalfFrom, secretCookies } from './secretkey.mjs';

const TOKEN_COOKIE = 'vscode-tkn';
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

/** Request headers for the upstream server (from Node's rawHeaders pairs). */
export function upstreamHeaderPairs(rawHeaders, token, { keepHop = false } = {}) {
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const lower = name.toLowerCase();
    if (lower === 'cookie' || lower === 'x-forwarded-prefix') continue;
    if (!keepHop && HOP.has(lower)) continue;
    out.push([name, rawHeaders[i + 1]]);
  }
  out.push(['Cookie', `${TOKEN_COOKIE}=${token}`]);
  return out;
}

const CONFIG_MARKER = 'id="vscode-workbench-web-configuration" data-settings="{';

/**
 * Put the connection token into the workbench configuration the page reads.
 *
 * The cookie alone is not enough: the workbench also sends the token inside
 * the WebSocket auth handshake, reading it from
 * `options.connectionToken || getCookieValue('vscode-tkn')`
 * (vscode/src/vs/workbench/browser/web.main.ts:327). With no readable cookie
 * the server logs "Unauthorized client refused: auth mismatch". The config is
 * HTML-escaped JSON in a meta attribute (webClientServer.ts, asJSON plus the
 * template's escaping), so the inserted member is escaped the same way.
 * Returns null when the marker is missing.
 */
export function injectConnectionToken(html, token) {
  if (!/^[A-Za-z0-9_-]+$/.test(token || '')) throw new Error('unsafe token');
  const i = html.indexOf(CONFIG_MARKER);
  if (i < 0) return null;
  const at = i + CONFIG_MARKER.length;
  return `${html.slice(0, at)}&quot;connectionToken&quot;:&quot;${token}&quot;,${html.slice(at)}`;
}

/**
 * Add the view-overlay script (backend/lib/view-overlay.js) to the workbench
 * page, before </head>, as a same-origin <script src>, which the workbench
 * CSP (`script-src 'self'`, webClientServer.ts:150) allows. Returns the HTML
 * unchanged when there is no </head>.
 */
export function injectOverlayScript(html, src) {
  if (!/^\/[A-Za-z0-9/_.-]+$/.test(src || '')) throw new Error('unsafe script path');
  const i = html.indexOf('</head>');
  if (i < 0) return html;
  return `${html.slice(0, i)}<script src="${src}"></script>
${html.slice(i)}`;
}

/** Drop the token cookie the server tries to set; the browser never needs it. */
export function filterSetCookie(values) {
  if (!values) return values;
  const list = Array.isArray(values) ? values : [values];
  const kept = list.filter((v) => !String(v).trim().toLowerCase().startsWith(TOKEN_COOKIE + '='));
  return kept.length ? kept : undefined;
}

const NOT_READY_HTML = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<title>VS Code is starting</title><body style="font:14px system-ui;background:#1e1e1e;color:#ccc;display:grid;place-items:center;height:100vh;margin:0">
<div>VS Code is starting&hellip;</div></body>`;

/**
 * @param {() => ({port:number, token:string}|null)} getTarget
 * @param {{overlayScriptPath?: string, overlayScript?: () => string, secretKey?: boolean}} [opts]
 *   overlayScriptPath: where the page loads the view-overlay script from (served
 *   here, never forwarded); secretKey: set the secret-storage cookies on the
 *   workbench page (lib/secretkey.mjs).
 */
export function createFrameProxy(getTarget, opts = {}) {
  function handleRequest(req, res) {
    if (opts.overlayScriptPath && opts.overlayScript && req.url.split('?')[0] === opts.overlayScriptPath) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        return res.end('method not allowed');
      }
      const body = Buffer.from(opts.overlayScript(), 'utf8');
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(body.length), 'x-content-type-options': 'nosniff' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    const target = getTarget();
    if (!target) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '2' });
      return res.end(NOT_READY_HTML);
    }
    const headers = {};
    for (const [k, v] of upstreamHeaderPairs(req.rawHeaders, target.token)) {
      const key = k.toLowerCase();
      headers[key] = key in headers ? `${headers[key]}, ${v}` : v;
    }
    const up = http.request(
      { host: '127.0.0.1', port: target.port, method: req.method, path: req.url, headers },
      (upRes) => {
        const h = { ...upRes.headers };
        const sc = filterSetCookie(h['set-cookie']);
        if (sc) h['set-cookie'] = sc;
        else delete h['set-cookie'];
        const isWorkbenchHtml =
          upRes.statusCode === 200 &&
          String(h['content-type'] || '').startsWith('text/html') &&
          !h['content-encoding'];
        if (!isWorkbenchHtml) {
          res.writeHead(upRes.statusCode || 502, h);
          upRes.pipe(res);
          return;
        }
        const chunks = [];
        upRes.on('data', (c) => chunks.push(c));
        upRes.on('end', () => {
          const html = Buffer.concat(chunks).toString('utf8');
          const withToken = injectConnectionToken(html, target.token);
          let page = withToken ?? html;
          // Only the workbench page itself (it carries the config marker).
          if (withToken !== null && opts.overlayScriptPath) page = injectOverlayScript(page, opts.overlayScriptPath);
          if (withToken !== null && opts.secretKey) {
            h['set-cookie'] = [...(h['set-cookie'] || []), ...secretCookies(clientHalfFrom(req.headers.cookie))];
          }
          const out = Buffer.from(page, 'utf8');
          delete h['transfer-encoding'];
          h['content-length'] = String(out.length);
          h['cache-control'] = 'no-store';
          res.writeHead(200, h);
          res.end(out);
        });
        upRes.on('error', () => res.destroy());
      },
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('VS Code server unreachable');
    });
    req.pipe(up);
  }

  function handleUpgrade(req, socket, head) {
    const target = getTarget();
    if (!target) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = net.connect(target.port, '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of upstreamHeaderPairs(req.rawHeaders, target.token, { keepHop: true })) {
        lines.push(`${k}: ${v}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const close = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on('error', close);
    socket.on('error', close);
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  }

  return { handleRequest, handleUpgrade };
}

/** Host header names a loopback address (blocks DNS rebinding to the launcher). */
export function isLoopbackHost(hostHeader) {
  const h = String(hostHeader || '').replace(/:\d+$/, '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
}

/**
 * A WebSocket upgrade to the workbench must come to a loopback Host and either
 * carry no Origin (non-browser clients) or the frame's own origin
 * `http://127.0.0.1:<launcher port>`, which is what the workbench in the
 * dashboard's iframe sends. Any other web page is refused.
 */
export function upgradeAllowed({ host, origin, listenPort }) {
  if (!isLoopbackHost(host)) return false;
  if (origin === undefined || origin === null || origin === '') return true;
  const o = String(origin).toLowerCase();
  return o === `http://127.0.0.1:${listenPort}` || o === `http://localhost:${listenPort}`;
}
