// The Kiro Crew tunnel: the live gateway dashboard served on the launcher's
// own loopback origin, so VS Code's "Kiro Crew" tab can frame the dashboard's
// own /embed/chat page (research R5). Node built-ins only.
//
// Origin. The browser reaches it only as http://<label>.localhost:<port>,
// where <label> is 128 random bits kept in data/state/kc-session.json. Every
// SPA request (assets, fetch('/api/..'), new WebSocket(location.host)) reuses
// location.host, so the label rides along; any other Host gets 421. The SPA
// is built for `/` (website/scripts/lib/basePath.mjs), hence a whole origin.
//
// Upstream. Host and Origin are rewritten to the same-origin loopback form
// http://127.0.0.1:<port>, which the gateway's check_host and same-origin
// loopback fallback accept (dashboard/origin.py:470-505); the gateway then
// names its cookies mc_token_<port> (token_auth_tokens.py:1290-1306).
// X-Forwarded-For marks every request as proxied, so the gateway refuses secret
// reveal, config writes and the host-desktop routes for this session
// (origin.py:110-136).
//
// Credentials. The browser never holds a Kiro Crew cookie: Set-Cookie from the
// gateway is captured here and stripped, and the stored values are injected
// upstream (the refresh cookie only under /api/auth, as its Path says). The
// pair is persisted owner-only so the tab survives launcher restarts.
//
// Boundary. Same-origin only (a foreign Origin, or a mutating request with no
// Origin, is 403), credential-minting and security-setup routes are refused
// here (DENY), /sw.js is 404 (the shell's worker would claim our origin),
// refreshes run one at a time (a replayed refresh revokes the chain,
// remote-and-mobile.md:702-706), frame-ancestors names the exact chain, and
// Referrer-Policy is no-referrer because the host name is the capability.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { restrictToUser } from './secretkey.mjs';

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']);
const DROP_REQ = new Set(['cookie', 'origin', 'host', 'referer', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'accept-encoding']);

/** Routes that mint credentials or change security setup: never through the tunnel. */
export const DENY = [
  /^\/api\/token\/local(\/|$)/i,
  /^\/api\/logout(\/|$)/i,
  /^\/api\/auth\/mobile-link(\/|$)/i,
  /^\/api\/tailnet(\/|$)/i,
  /^\/api\/instances\/[^/]+\/(connect|refresh-token|embed-token)(\/|$)/i,
  /^\/api\/apps\/[^/]+\/token(\/|$)/i,
  /^\/api\/webhooks\/tokens(\/|$)/i,
  /^\/api\/relay-viewer\/token(\/|$)/i,
  /^\/api\/secrets(\/|$|-)/i,
];

/** The request path, decoded and with repeated slashes collapsed, for the deny list. */
export function normalPath(url) {
  let p = String(url || '/').split('?')[0].split('#')[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    return null;
  }
  return p.replace(/\/{2,}/g, '/').replace(/\/\.(?=\/|$)/g, '');
}

export function denied(url) {
  const p = normalPath(url);
  return p === null || /\/\.\.(\/|$)/.test(p) || DENY.some((re) => re.test(p));
}

/** A sign-in link (`http://host/?token=…`) or a bare link token, to the token; null when it is neither. */
export function linkToken(input) {
  const s = String(input || '').trim();
  if (!s || s.length > 8192) return null;
  let t = s;
  if (/^https?:\/\//i.test(s)) {
    try {
      t = new URL(s).searchParams.get('token') || '';
    } catch {
      return null;
    }
  }
  return /^[A-Za-z0-9_.-]{16,4096}$/.test(t) ? t : null;
}

/** The `exp` (seconds) of a JWT-shaped token, without verifying it; 0 when unreadable. */
export function jwtExp(token) {
  try {
    const part = String(token || '').split('.')[1];
    const exp = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')).exp;
    return Number.isFinite(exp) ? exp : 0;
  } catch {
    return 0;
  }
}

/** Capture mc_token_* / mc_refresh_* from Set-Cookie lines into `session` ({token, refresh}); true if it changed. */
export function captureCookies(setCookie, session) {
  let changed = false;
  for (const line of [].concat(setCookie || [])) {
    const [pair, ...attrs] = String(line).split(';');
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const m = /^mc_(token|refresh)_\d+$/.exec(pair.slice(0, eq).trim());
    if (!m) continue;
    const kind = m[1] === 'token' ? 'token' : 'refresh';
    const value = pair.slice(eq + 1).trim().replace(/^"|"$/g, '');
    const dead = value === '' || attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a) || (/^\s*expires\s*=/i.test(a) && Date.parse(a.split('=')[1]) < Date.now()));
    if (dead) {
      if (session[kind]) {
        session[kind] = '';
        changed = true;
      }
    } else if (session[kind] !== value) {
      session[kind] = value;
      changed = true;
    }
  }
  return changed;
}

/** CSP with frame-ancestors replaced by the given chain. */
export function withFrameAncestors(csp, ancestors) {
  const fa = ancestors.length ? ancestors.join(' ') : "'none'";
  const s = String(csp || '');
  return /frame-ancestors/i.test(s) ? s.replace(/frame-ancestors[^;]*/i, `frame-ancestors ${fa}`) : `${s}${s && !/;\s*$/.test(s) ? '; ' : ''}frame-ancestors ${fa}`;
}

const newLabel = () => crypto.randomBytes(16).toString('hex');

/** The persisted tunnel state: {label, port, token, refresh, signedInAt}. */
export function loadKcState(file) {
  let v = null;
  try {
    v = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    v = null;
  }
  const ok = (x) => (typeof x === 'string' && /^[A-Za-z0-9_.\-~+/=]{1,8192}$/.test(x) ? x : '');
  return {
    label: v && /^[0-9a-f]{32}$/.test(v.label) ? v.label : newLabel(),
    port: v && Number.isInteger(v.port) && v.port > 0 && v.port < 65536 ? v.port : 0,
    token: ok(v && v.token),
    refresh: ok(v && v.refresh),
    signedInAt: v && typeof v.signedInAt === 'string' ? v.signedInAt : null,
  };
}

export function saveKcState(file, st, { restrict = restrictToUser } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ label: st.label, port: st.port, token: st.token, refresh: st.refresh, signedInAt: st.signedInAt }) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  restrict(file);
}

/**
 * @param {object} o
 * @param {string} o.gatewayHost  upstream host (127.0.0.1)
 * @param {number} o.gatewayPort  upstream port
 * @param {string} o.stateFile    data/state/kc-session.json
 * @param {() => string[]} o.frameAncestors  the frame chain, read per response
 * @param {string} [o.css]        stylesheet added to every HTML page the tunnel serves
 * @param {(line: string) => void} [o.log]
 * @param {() => void} [o.onChange]  the session or the origin changed
 */
export function createKcProxy({ gatewayHost = '127.0.0.1', gatewayPort, stateFile, frameAncestors = () => [], css = '', log = () => {}, onChange = () => {}, restrict = restrictToUser }) {
  const st = loadKcState(stateFile);
  let port = 0;
  let refreshChain = Promise.resolve();
  let lastError = '';
  const publicHost = () => `${st.label}.localhost:${port}`;
  const publicOrigin = () => `http://${publicHost()}`;
  const upstreamHost = () => `127.0.0.1:${port}`;
  const persist = () => {
    try {
      saveKcState(stateFile, st, { restrict });
    } catch (e) {
      log(`kc: could not save the session (${e.code || e.message})`);
    }
  };
  const changed = () => {
    persist();
    onChange();
  };

  function gate(req) {
    const host = String(req.headers.host || '').toLowerCase();
    if (!port || host !== publicHost()) return 'host';
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== publicOrigin()) return 'origin';
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutating && origin === undefined) return 'origin-missing';
    return null;
  }

  function cookieHeader(pathname) {
    const parts = [];
    if (st.token) parts.push(`mc_token_${port}=${st.token}`);
    if (st.refresh && /^\/api\/auth(\/|$)/i.test(pathname)) parts.push(`mc_refresh_${port}=${st.refresh}`);
    return parts.join('; ');
  }

  function upstreamHeaders(rawHeaders, { hasOrigin, pathname, upgrade }) {
    const h = {};
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const k = rawHeaders[i].toLowerCase();
      if (DROP_REQ.has(k) || (HOP.has(k) && !upgrade)) continue;
      h[k] = k in h ? `${h[k]}, ${rawHeaders[i + 1]}` : rawHeaders[i + 1];
    }
    h.host = upstreamHost();
    if (hasOrigin) h.origin = `http://${upstreamHost()}`;
    h['x-forwarded-for'] = '127.0.0.1';
    const c = cookieHeader(pathname);
    if (c) h.cookie = c;
    return h;
  }

  function rewriteHeaders(h) {
    const out = { ...h };
    if (captureCookies(out['set-cookie'], st)) {
      if (st.token && !st.signedInAt) st.signedInAt = new Date().toISOString();
      if (!st.token && !st.refresh) st.signedInAt = null;
      changed();
    }
    delete out['set-cookie'];
    delete out['x-frame-options'];
    delete out['strict-transport-security'];
    out['content-security-policy'] = withFrameAncestors(out['content-security-policy'], frameAncestors());
    out['referrer-policy'] = 'no-referrer';
    return out;
  }

  function injectCss(html) {
    if (!css) return html;
    const tag = `<style id="kc-vscode-pane">${css}</style>`;
    const i = html.search(/<\/head>/i);
    return i < 0 ? tag + html : html.slice(0, i) + tag + html.slice(i);
  }

  /** Forward one request upstream; resolves when the response is finished. */
  function forward(req, res, pathname, body) {
    return new Promise((resolve) => {
      const up = http.request(
        { host: gatewayHost, port: gatewayPort, method: req.method, path: req.url, headers: upstreamHeaders(req.rawHeaders, { hasOrigin: req.headers.origin !== undefined, pathname }) },
        (upRes) => {
          log(`kc ${req.method} ${pathname} ${upRes.statusCode}`);
          const h = rewriteHeaders(upRes.headers);
          const html = String(h['content-type'] || '').startsWith('text/html') && !h['content-encoding'] && css;
          if (!html) {
            res.writeHead(upRes.statusCode || 502, h);
            upRes.pipe(res);
            upRes.on('end', resolve);
            upRes.on('error', resolve);
            return;
          }
          const chunks = [];
          upRes.on('data', (c) => chunks.push(c));
          upRes.on('end', () => {
            const out = Buffer.from(injectCss(Buffer.concat(chunks).toString('utf8')), 'utf8');
            delete h['transfer-encoding'];
            h['content-length'] = String(out.length);
            res.writeHead(upRes.statusCode || 502, h);
            res.end(out);
            resolve();
          });
          upRes.on('error', resolve);
        },
      );
      up.on('error', (e) => {
        lastError = e.code || e.message;
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('Kiro Crew is not reachable');
        resolve();
      });
      if (body) up.end(body);
      else req.pipe(up);
    });
  }

  /** Run fn after every refresh before it; refreshes never overlap. */
  function serialRefresh(fn) {
    const run = refreshChain.then(fn, fn);
    refreshChain = run.catch(() => {});
    return run;
  }

  const server = http.createServer((req, res) => {
    const refused = gate(req);
    const pathname = normalPath(req.url) || '/';
    if (refused) {
      log(`kc refused ${req.method} ${pathname} (${refused})`);
      res.writeHead(refused === 'host' ? 421 : 403, { 'content-type': 'text/plain' });
      return res.end(refused === 'host' ? 'misdirected' : 'forbidden');
    }
    if (denied(req.url)) {
      log(`kc denied ${req.method} ${pathname}`);
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not available in the VS Code tab', code: 'kc_tunnel_denied' }));
    }
    if (pathname === '/sw.js') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end();
    }
    if (req.method === 'POST' && /^\/api\/auth\/refresh$/i.test(pathname)) {
      // Buffer the (small) body, then forward after any refresh in flight, so
      // the second request carries the rotated cookie.
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => serialRefresh(() => forward(req, res, pathname, Buffer.concat(chunks))));
      return;
    }
    forward(req, res, pathname);
  });

  // Upgraded sockets leave the HTTP server's books; close() ends them itself.
  const sockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const refused = gate(req);
    const pathname = normalPath(req.url) || '/';
    if (refused || denied(req.url)) {
      log(`kc refused WebSocket ${pathname} (${refused || 'denied'})`);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = net.connect(gatewayPort, gatewayHost, () => {
      const h = upstreamHeaders(req.rawHeaders, { hasOrigin: req.headers.origin !== undefined, pathname, upgrade: true });
      h.connection = 'Upgrade';
      h.upgrade = req.headers.upgrade;
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(h).map(([k, v]) => `${k}: ${v}`)];
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.once('data', (chunk) => {
        log(`kc WebSocket ${pathname} ${chunk.toString('latin1').split('\r\n')[0].slice(9, 12)}`);
        socket.write(chunk);
        upstream.pipe(socket);
      });
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
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  /** A request from the launcher itself to the gateway, as the tunnel's own origin. */
  function selfRequest(method, p) {
    return new Promise((resolve) => {
      const pathname = normalPath(p) || '/';
      const headers = { host: upstreamHost(), origin: `http://${upstreamHost()}`, 'x-forwarded-for': '127.0.0.1', accept: 'application/json' };
      const c = cookieHeader(pathname);
      if (c) headers.cookie = c;
      if (method !== 'GET') headers['content-length'] = '0';
      const req = http.request({ host: gatewayHost, port: gatewayPort, method, path: p, headers }, (res) => {
        const chunks = [];
        res.on('data', (x) => chunks.push(x));
        res.on('end', () => {
          if (captureCookies(res.headers['set-cookie'], st)) changed();
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode, body });
        });
      });
      req.setTimeout(15_000, () => req.destroy(new Error('timeout')));
      req.on('error', (e) => resolve({ status: 0, body: null, error: e.code || e.message }));
      req.end();
    });
  }

  return {
    server,
    listen(preferred, host = '127.0.0.1') {
      const tryPort = (p, fallback) =>
        new Promise((resolve, reject) => {
          const onError = (e) => {
            server.off('listening', onListening);
            if (fallback && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) resolve(tryPort(0, false));
            else reject(e);
          };
          const onListening = () => {
            server.off('error', onError);
            resolve(server.address().port);
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(p, host);
        });
      return tryPort(preferred ?? st.port, !!(preferred ?? st.port)).then((p) => {
        port = p;
        if (st.port !== p) {
          st.port = p;
          persist();
        }
        return p;
      });
    },
    close() {
      for (const s of sockets) s.destroy();
      server.closeAllConnections?.();
      return new Promise((r) => server.close(() => r()));
    },
    get port() {
      return port;
    },
    get origin() {
      return publicOrigin();
    },
    /** What the page and the bridge may know: no cookie value, ever. */
    status() {
      const exp = jwtExp(st.token);
      return {
        connected: !!(st.token || st.refresh),
        accessExpiresAt: exp ? new Date(exp * 1000).toISOString() : null,
        canRefresh: !!st.refresh,
        signedInAt: st.signedInAt,
        lastError: lastError || null,
      };
    },
    /**
     * Trade a sign-in link (or its bare token) for a session, the way the
     * dashboard's own sign-in banner does: GET /api/auth/me?token=… through the
     * tunnel origin (website/src/api/client.ts:581-593). The link is never stored.
     */
    async signIn(link) {
      const t = linkToken(link);
      if (!t) return { ok: false, status: 400, error: 'not a sign-in link' };
      if (!port) return { ok: false, status: 503, error: 'the tunnel is not listening' };
      const before = { token: st.token, refresh: st.refresh };
      st.token = '';
      st.refresh = '';
      const r = await selfRequest('GET', `/api/auth/me?token=${encodeURIComponent(t)}`);
      if (r.status === 200 && st.token) {
        st.signedInAt = new Date().toISOString();
        lastError = '';
        changed();
        log('kc signed in');
        return { ok: true, status: 200 };
      }
      // A refused link leaves the earlier session as it was.
      st.token = before.token;
      st.refresh = before.refresh;
      lastError = r.error || (r.body && (r.body.code || r.body.error)) || `HTTP ${r.status}`;
      changed();
      log(`kc sign-in refused: ${lastError}`);
      return { ok: false, status: r.status || 502, error: lastError };
    },
    /** Rotate the access cookie with the refresh cookie (serialised with the tab's own refreshes). */
    refresh() {
      if (!st.refresh) return Promise.resolve({ ok: false, error: 'no refresh cookie' });
      return serialRefresh(async () => {
        const r = await selfRequest('POST', '/api/auth/refresh');
        if (r.status !== 200) {
          lastError = (r.body && (r.body.code || r.body.error)) || `HTTP ${r.status}`;
          if (r.status === 401) {
            st.token = '';
            st.refresh = '';
            st.signedInAt = null;
            changed();
          }
          return { ok: false, error: lastError };
        }
        return { ok: true };
      });
    },
    /**
     * Sign this tab out: POST /api/auth/logout (this chain only,
     * auth_refresh.py:882-898), forget the session and rotate the origin, so a
     * frame still holding the old URL gets 421.
     */
    async disconnect() {
      if (st.token || st.refresh) await selfRequest('POST', '/api/auth/logout');
      st.token = '';
      st.refresh = '';
      st.signedInAt = null;
      st.label = newLabel();
      lastError = '';
      changed();
      log('kc disconnected; origin rotated');
      return { ok: true };
    },
  };
}
