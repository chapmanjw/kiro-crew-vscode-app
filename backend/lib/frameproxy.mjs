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
 */
export function createFrameProxy(getTarget) {
  function handleRequest(req, res) {
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
          const out = Buffer.from(injectConnectionToken(html, target.token) ?? html, 'utf8');
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
