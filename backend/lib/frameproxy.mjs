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
import { injectScriptTag } from './overlay.mjs';

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
 * Serve VS Code's webviews from loopback instead of https://*.vscode-cdn.net:
 * set `webviewEndpoint` in the workbench configuration (read before the
 * product default, environmentService.ts webviewExternalEndpoint) to
 * http://{{uuid}}.localhost:<frame port><static route>/out/vs/workbench/contrib/webview/browser/pre/.
 * The webview host page requires its host name to start with a hash of the
 * parent origin and a secure context (pre/index.html), which a
 * `<uuid>.localhost` host on loopback satisfies with one origin per webview.
 * Every frame in the chain is then loopback, so the Kiro Crew tab (a webview
 * framing the tunnel) never crosses from a public origin to loopback, and
 * webviews work offline. The static route is read from the page's own
 * workbench.js URL. Returns null when the marker or the route is missing.
 */
export function injectWebviewEndpoint(html, framePort) {
  if (!Number.isInteger(framePort) || framePort <= 0) throw new Error('bad port');
  const m = /src="([^"]*)\/out\/vs\/code\/browser\/workbench\/workbench\.js"/.exec(html);
  if (!m || !/^\/[A-Za-z0-9/_.-]*$/.test(m[1])) return null;
  const i = html.indexOf(CONFIG_MARKER);
  if (i < 0) return null;
  const endpoint = `http://{{uuid}}.localhost:${framePort}${m[1]}/out/vs/workbench/contrib/webview/browser/pre/`;
  const at = i + CONFIG_MARKER.length;
  return `${html.slice(0, at)}&quot;webviewEndpoint&quot;:&quot;${endpoint}&quot;,${html.slice(at)}`;
}

/** The setting that tells the bridge extension which page tab its window is (extension package.json). */
export const PANE_TAB_SETTING = 'kiroCrew.paneTab';

/**
 * Tell the window which of the page's tabs it is: `configurationDefaults` in
 * the workbench configuration (IWorkbenchConstructionOptions; the browser's
 * DefaultConfiguration registers it, and the extension host gets defaults with
 * its configuration) sets the default of kiroCrew.paneTab to the tab id. The
 * server sets no configurationDefaults of its own (webClientServer.ts). Only a
 * tab id (`t` and 12 hex digits) is accepted. Returns null when the marker is missing.
 */
export function injectConfigurationDefaults(html, tab) {
  if (!/^t[0-9a-f]{12}$/.test(tab || '')) throw new Error('bad tab id');
  const i = html.indexOf(CONFIG_MARKER);
  if (i < 0) return null;
  const at = i + CONFIG_MARKER.length;
  return `${html.slice(0, at)}&quot;configurationDefaults&quot;:{&quot;${PANE_TAB_SETTING}&quot;:&quot;${tab}&quot;},${html.slice(at)}`;
}

/** Add http://*.localhost:<port> to a CSP's frame-src (or create one), leaving every other directive alone. */
export function allowWebviewFrames(csp, port) {
  const src = `http://*.localhost:${port}`;
  const parts = String(csp).split(';').map((d) => d.trim()).filter(Boolean);
  const i = parts.findIndex((d) => /^frame-src\s/i.test(d) || d.toLowerCase() === 'frame-src');
  if (i >= 0) {
    if (!parts[i].split(/\s+/).includes(src)) parts[i] = `${parts[i]} ${src}`;
  } else parts.push(`frame-src 'self' ${src}`);
  return parts.join('; ') + ';';
}

/** Drop the token cookie the server tries to set; the browser never needs it. */
export function filterSetCookie(values) {
  if (!values) return values;
  const list = Array.isArray(values) ? values : [values];
  const kept = list.filter((v) => !String(v).trim().toLowerCase().startsWith(TOKEN_COOKIE + '='));
  return kept.length ? kept : undefined;
}

/**
 * The page served while the server is not up. `boot` is `{kind, bg, fg}`
 * (theme.mjs bootColors) so even this page is the Kiro Crew colour.
 */
export function notReadyHtml(boot = { kind: 'dark', bg: '#1f1f1f', fg: '#cccccc' }) {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2"><meta name="color-scheme" content="${boot.kind}">
<title>VS Code is starting</title><body style="font:14px system-ui;background:${boot.bg};color:${boot.fg};color-scheme:${boot.kind};display:grid;place-items:center;height:100vh;margin:0">
<div>VS Code is starting&hellip;</div></body>`;
}

/**
 * Put a `<style id="vscp-boot">` first in the workbench page's <head>, so the
 * page is the Kiro Crew colour from its first paint, before workbench.css or
 * VS Code's own scripts run. `css` comes from theme.mjs bootCss (hex colours
 * only). Returns null when the page has no <head>.
 */
export function injectBootStyle(html, css) {
  if (/[<>]/.test(css)) throw new Error('unsafe css');
  const m = /<head(\s[^>]*)?>/i.exec(html);
  if (!m) return null;
  const at = m.index + m[0].length;
  return `${html.slice(0, at)}<style id="vscp-boot">${css}</style>${html.slice(at)}`;
}

/**
 * @param {() => ({port:number, token:string}|null)} getTarget
 * @param {{webviewPort?: () => number, secretKey?: boolean, boot?: () => ({css:string, colors:object})}} [opts]
 *   webviewPort: serve webviews from http://<uuid>.localhost:<port> (see
 *   injectWebviewEndpoint); secretKey: set the secret-storage cookies on the
 *   workbench page (lib/secretkey.mjs).
 */
export function createFrameProxy(getTarget, opts = {}) {
  function handleRequest(req, res, ctx = {}) {
    const target = getTarget();
    if (!target) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '2' });
      return res.end(notReadyHtml(opts.boot ? opts.boot().colors : undefined));
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
          // Not on the app web origin: there is one origin there, so no per-webview
          // `<uuid>.localhost` names, and VS Code's default webview endpoint is used.
          if (withToken !== null && !ctx.webOrigin && opts.webviewPort && opts.webviewPort() > 0) {
            const withEndpoint = injectWebviewEndpoint(page, opts.webviewPort());
            if (withEndpoint !== null) {
              page = withEndpoint;
              // The workbench CSP frames only 'self' and https://*.vscode-cdn.net
              // (webClientServer.ts:152); allow the self-hosted webview origins.
              if (h['content-security-policy']) h['content-security-policy'] = allowWebviewFrames(h['content-security-policy'], opts.webviewPort());
            }
          }
          // The web origin's viewer cookie and chat overlay script (lib/overlay.mjs).
          if (withToken !== null && ctx.setCookies && ctx.setCookies.length) h['set-cookie'] = [...(h['set-cookie'] || []), ...ctx.setCookies];
          if (withToken !== null && ctx.scriptSrc) page = injectScriptTag(page, ctx.scriptSrc) ?? page;
          // Which page tab this window is (the page loads each tab with ?vscpTab=<id>).
          if (withToken !== null && ctx.paneTab) page = injectConfigurationDefaults(page, ctx.paneTab) ?? page;
          if (withToken !== null && opts.secretKey) {
            h['set-cookie'] = [...(h['set-cookie'] || []), ...secretCookies(clientHalfFrom(req.headers.cookie))];
          }
          // The theme's first paint (see injectBootStyle); only the workbench page itself.
          if (withToken !== null && opts.boot) page = injectBootStyle(page, opts.boot().css) ?? page;
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
  // <name>.localhost always resolves to loopback (RFC 6761); the self-hosted
  // webview origins (injectWebviewEndpoint) use it.
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || /^[a-z0-9-]{1,63}\.localhost$/.test(h);
}

/** A self-hosted webview origin (`<uuid>.localhost:<port>`), not the workbench's own 127.0.0.1/localhost. */
export function isWebviewHost(hostHeader) {
  const h = String(hostHeader || '').replace(/:\d+$/, '').toLowerCase();
  return /^[a-z0-9-]{1,63}\.localhost$/.test(h);
}

/**
 * The app's web origin host, `<app>.apps.localhost[:port]`: how the gateway's
 * `backend.webOrigin` relay names this app (kiro_crew/apps/app_web_origin.py).
 * The relay reaches the launcher's own port with this `Host`, from a browser
 * that is on another machine than the launcher.
 */
export function isWebOriginHost(hostHeader, appName) {
  const m = /^([a-z0-9-]{1,63})\.apps\.localhost(?::\d{1,5})?$/.exec(String(hostHeader || '').toLowerCase());
  return !!m && m[1] === String(appName || '').toLowerCase();
}

/** On the web origin the workbench's own origin is the Host it was served under. */
function webOriginOk(host, origin) {
  if (origin === undefined || origin === null || origin === '') return true;
  return String(origin).toLowerCase() === `http://${String(host).toLowerCase()}`;
}

const WEBVIEW_PRE = '/out/vs/workbench/contrib/webview/browser/pre/';

/**
 * What a webview origin may fetch from the frame listener: GET or HEAD of the
 * webview host files only, `<base path>/<product path>/static/out/vs/workbench/contrib/webview/browser/pre/<file>`.
 * Everything else is 403, `/vscode-remote-resource` (any file the account can
 * read, remoteExtensionHostAgentServer.ts:157-188) and the workbench included:
 * webview URLs carry the frame key in their path, so without this gate script
 * in any webview could reach the whole workbench with the connection token
 * the proxy adds. A webview's own resources go through its service worker and
 * the workbench (postMessage), not this listener.
 */
export function webviewRequestAllowed(method, rawUrl, basePath) {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const target = String(rawUrl || '');
  if (!target.startsWith('/')) return false;
  const p = target.split('?')[0];
  // No encoding tricks and no dot segments: the path must be the plain file path.
  if (/%|\\|\/\.{1,2}(\/|$)|\/\//.test(p)) return false;
  const prefix = `${basePath}/`;
  if (!p.startsWith(prefix)) return false;
  const rest = p.slice(prefix.length); // <product path>/static/out/vs/.../pre/<file>
  const m = /^[A-Za-z0-9._-]+\/static(\/.*)$/.exec(rest);
  if (!m || !m[1].startsWith(WEBVIEW_PRE)) return false;
  return /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(m[1].slice(WEBVIEW_PRE.length));
}

/**
 * A WebSocket upgrade to the workbench must come to a loopback Host and either
 * carry no Origin (non-browser clients) or the frame's own origin
 * `http://127.0.0.1:<launcher port>`, which is what the workbench in the
 * dashboard's iframe sends. Any other web page is refused.
 */
export function upgradeAllowed({ host, origin, listenPort, appName }) {
  if (appName && isWebOriginHost(host, appName)) return webOriginOk(host, origin);
  if (!isLoopbackHost(host)) return false;
  if (origin === undefined || origin === null || origin === '') return true;
  const o = String(origin).toLowerCase();
  return o === `http://127.0.0.1:${listenPort}` || o === `http://localhost:${listenPort}`;
}
