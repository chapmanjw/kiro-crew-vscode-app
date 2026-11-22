// The owner-session side of a mock Kiro Crew gateway, for the tunnel tests and
// the smoke: sign-in links, the link-to-session exchange, refresh, logout, a
// dashboard /embed/chat page and the /api/ws socket, with the same contracts
// as the real gateway:
//   - GET /api/auth/me?token=<link> trades a link for a session: Set-Cookie
//     mc_token_<Host port> (HttpOnly; SameSite=Lax; Path=/) and
//     mc_refresh_<Host port> (Path=/api/auth) (token_auth.py:1077-1130,
//     auth_refresh.py:225-281; the name follows the Host header,
//     token_auth_tokens.py:1290-1306). Links are single use, 5 minutes.
//   - POST /api/auth/refresh rotates both; a refresh token used twice revokes
//     the chain (remote-and-mobile.md:702-706).
//   - POST /api/auth/logout ends the chain and deletes both cookies.
//   - Host must be loopback; an Origin must equal http://<Host> (the
//     same-origin loopback fallback, origin.py:470-505), else 403 bad_origin.
//   - HTML carries X-Frame-Options: SAMEORIGIN and frame-ancestors 'self'
//     (security_headers.py:220-267), which the tunnel must rewrite.
//   - The embed page draws the composer chips the way ContextShelf.tsx does,
//     inside the real embed shell's box chain (see PAGE).
// Routes the tunnel must never forward (/api/token/local, /api/auth/mobile-link,
// ...) answer 200 here and are recorded in rec.dash.forbiddenHits.
import crypto from 'node:crypto';

export function attachDashboard(rec) {
  const dash = { links: new Map(), sessions: new Map(), refresh: new Map(), exchanges: 0, refreshes: 0, refreshInFlight: 0, maxRefreshInFlight: 0, reuse: 0, logouts: 0, wsOpens: 0, forbiddenHits: [], badOrigin: 0, xff: 0, pages: 0, localSecret: '', localMints: 0, localDenied: 0, localTtls: [] };
  rec.dash = dash;
  const id = () => crypto.randomBytes(18).toString('base64url');
  const jwt = (sub, ttl) => {
    const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b({ alg: 'HS256' })}.${b({ sub, exp: Math.floor(Date.now() / 1000) + ttl, n: id() })}.${id()}`;
  };
  const hostPort = (req) => (/:(\d+)$/.exec(String(req.headers.host || '')) || [])[1] || '';
  const cookie = (req, name) => (new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '') || [])[1] || '';
  const sessionOf = (req) => {
    const t = cookie(req, `mc_token_${hostPort(req)}`);
    return t && dash.sessions.get(t) ? t : '';
  };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const issue = (res, req, status, body) => {
    const p = hostPort(req);
    const access = jwt('owner', 3600);
    const refresh = id();
    dash.sessions.set(access, { user: 'owner' });
    dash.refresh.set(refresh, { used: false });
    send(res, status, body, {
      'set-cookie': [`mc_token_${p}=${access}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`, `mc_refresh_${p}=${refresh}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=2592000`],
    });
  };

  // The embed page's box chain mirrors the real /embed/chat (0.14 source; the
  // 0.13.0-rc.1 bundle renders the same classes): Tailwind preflight's body
  // margin 0 and `html,body,#root{height:100%}` (index.css:84); the embed
  // shell `h-screen w-screen overflow-hidden bg-bg flex flex-col` with
  // EmbedTabStrip's `shrink-0 border-b` row and a `flex-1 min-h-0` route box
  // (App.tsx:680-692); ChatPageFrame `flex flex-1 min-h-0 h-full
  // overflow-hidden relative` (ChatPageFrame.tsx:74); the chat pane root
  // `[data-chat-scope]` with its inline `margin-left:-8px` while the sessions
  // sidebar is closed (ChatPage.tsx:112, 1140); the composer dock
  // `absolute left-0 bottom-0` (ComposerDockView.tsx:414) holding
  // `.input-area px-4 pb-1 pt-1` (ChatInput.tsx:970), the 16px-radius glass
  // pane `[data-testid=composer-dock]` (ChatInput.tsx:1087-1096) and, below
  // it, the context shelf `glass-shelf pt-1 flex` (ChatInput.tsx:1824).
  const PAGE = (slot) => `<!doctype html><html><head><meta charset="utf-8"><title>Kiro Crew</title>
<style>html,body,#root{height:100%}body{margin:0;font:13px system-ui;background:#21222c;color:#f8f8f2}
.h-screen{height:100vh}.w-screen{width:100vw}.overflow-hidden{overflow:hidden}.bg-bg{background:#21222c}.flex{display:flex}.flex-col{flex-direction:column}
.shrink-0{flex-shrink:0}.border-b{border-bottom:1px solid #3a3d4e}.flex-1{flex:1 1 0%}.min-h-0{min-height:0}.min-w-0{min-width:0}.h-full{height:100%}.relative{position:relative}
.tabs{display:flex;align-items:center;padding:6px}.tab{padding:6px 8px;border-radius:6px;font-size:12px}
.transcript{padding:12px 16px 120px;overflow:auto;height:100%;box-sizing:border-box}
.dock{position:absolute;left:0;bottom:0;right:0}
.input-area{padding:4px 16px 4px;margin:0 auto;width:100%;max-width:900px;display:flex;flex-direction:column;box-sizing:border-box}
.glass{border:1px solid #3a3d4e;border-radius:16px;min-height:44px;background:#282a36;padding:10px 14px;box-sizing:border-box;color:#a3a6c4}
.glass-shelf{padding-top:4px;display:flex;align-items:center;gap:8px;min-width:0}
.chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;border:0;background:transparent;color:#a3a6c4}
.chip-row{display:flex;gap:8px}.card{background:#282a36;border:1px solid #3a3d4e;border-radius:12px;padding:8px 10px;margin:8px 0}</style></head>
<body><div id="root"><div class="h-screen w-screen overflow-hidden bg-bg flex flex-col" data-mock="embed-shell">
<div class="shrink-0 border-b"><div class="tabs"><span class="tab">Session</span></div></div>
<div class="flex-1 min-h-0"><div class="flex flex-1 min-h-0 h-full overflow-hidden relative">
<div data-chat-scope="" class="relative flex flex-col bg-bg min-w-0 min-h-0 h-full overflow-hidden flex-1" style="margin-left:-8px">
<div class="transcript"><div id="state">Loading</div><div class="card">Kiro Crew mock dashboard: /embed/chat/<span id="slot">${slot.replace(/[^A-Za-z0-9_.:-]/g, '')}</span></div><div id="ws">ws: closed</div>
<div id="signin" hidden><p>SIGN IN REQUIRED</p><input id="link" aria-label="Sign-in link"><button id="go" type="button">Sign in</button></div></div>
<div class="dock" data-testid="composer-dock-root"><div class="input-area" data-testid="mock-composer">
<div class="glass" data-testid="composer-dock">Message Kiro Crew</div>
<div class="glass-shelf" data-testid="composer-context-shelf"><div class="chip-row" data-testid="chip-row">
<button type="button" class="chip" data-session-control-chip="" title="Open in Code" aria-label="Open in Code" data-chip-id="vscode-pane:open-in-vscode"><svg class="lucide lucide-package" width="13" height="13" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16"></rect></svg><span>Code</span></button>
<button type="button" class="chip" data-session-control-chip="" title="Package app" aria-label="Package app" data-chip-id="package-app:control"><svg class="lucide lucide-package" width="13" height="13" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16"></rect></svg><span>Package app</span></button>
<button type="button" class="chip" data-session-control-chip="" title="Other app" aria-label="Other app" data-chip-id="other-app:control"><svg class="lucide lucide-zap" width="13" height="13" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16"></rect></svg><span>Other app</span></button>
</div><span class="chip">Ultra Mode</span></div></div></div>
</div></div></div></div></div>
<script>
async function boot() {
  const r = await fetch('/api/auth/me');
  if (r.ok) {
    document.getElementById('state').textContent = 'Signed in to Kiro Crew mock';
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/ws?caps=slot_patch');
    ws.onmessage = (e) => { document.getElementById('ws').textContent = 'ws: ' + e.data; };
    ws.onclose = () => { if (!/hello/.test(document.getElementById('ws').textContent)) document.getElementById('ws').textContent = 'ws: closed'; };
  } else {
    document.getElementById('state').textContent = 'Sign in required';
    document.getElementById('signin').hidden = false;
  }
}
document.getElementById('go').onclick = async () => {
  const v = document.getElementById('link').value.trim();
  const t = /token=([^&]+)/.exec(v);
  const r = await fetch('/api/auth/me?token=' + encodeURIComponent(t ? decodeURIComponent(t[1]) : v));
  if (r.ok) location.reload();
};
boot();
</script></body></html>`;

  /** A sign-in link, as `kirocrew token` or POST /api/auth/mobile-link would mint it. */
  function mintLink(origin = 'http://localhost:5476') {
    const t = jwt('link', 300);
    dash.links.set(t, { used: false, exp: Date.now() + 300_000 });
    return `${origin}/?token=${t}`;
  }

  /** Handle a dashboard request; false when it is not one. */
  function handle(req, res, url) {
    const p = url.pathname;
    const isDash = p === '/' || p.startsWith('/embed/') || p.startsWith('/api/auth/') || p === '/api/token/local' || p === '/api/logout' || p.startsWith('/api/tailnet') || /^\/api\/apps\/[^/]+\/token-mint$/.test(p);
    if (!isDash) return false;
    if (req.headers['x-forwarded-for']) dash.xff++;
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 421, { error: 'bad host' }), true;
    if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) {
      dash.badOrigin++;
      return send(res, 403, { error: 'bad_origin', code: 'bad_origin' }), true;
    }
    if (p === '/api/token/local' && req.method === 'GET' && !req.headers['x-forwarded-for'] && dash.localSecret && req.headers['x-local-secret'] === dash.localSecret) {
      // The local-owner bootstrap (core_local_token.py), reached directly on
      // loopback by the launcher and never through the tunnel (which adds
      // X-Forwarded-For). It answers a token the link exchange accepts.
      dash.localMints++;
      const t = jwt('link', 300);
      dash.links.set(t, { used: false, exp: Date.now() + 300_000 });
      dash.localTtls.push(url.searchParams.get('ttl'));
      return send(res, 200, { token: t, expires_in: 72000 }), true;
    }
    if (p === '/api/token/local' && !req.headers['x-forwarded-for'] && dash.localSecret) {
      dash.localDenied++;
      return send(res, 403, { error: 'invalid secret', code: 'invalid_secret' }), true;
    }
    if (p === '/api/token/local' || p === '/api/logout' || p === '/api/auth/mobile-link' || p.startsWith('/api/tailnet')) {
      dash.forbiddenHits.push(`${req.method} ${p}`);
      return send(res, 200, { token: 'should-never-be-reached' }), true;
    }
    if (p === '/' || p.startsWith('/embed/')) {
      dash.pages++;
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'x-frame-options': 'SAMEORIGIN',
        'strict-transport-security': 'max-age=31536000',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; frame-ancestors 'self'",
      });
      res.end(PAGE(decodeURIComponent(p.split('/').pop() || '')));
      return true;
    }
    if (p === '/api/auth/me' && req.method === 'GET') {
      const t = url.searchParams.get('token');
      if (t) {
        const l = dash.links.get(t);
        if (!l || l.used || l.exp < Date.now()) return send(res, 401, { error: 'invalid_token', code: 'invalid_token' }), true;
        l.used = true;
        dash.exchanges++;
        issue(res, req, 200, { user: 'owner' });
        return true;
      }
      return sessionOf(req) ? send(res, 200, { user: 'owner' }) : send(res, 401, { error: 'unauthenticated' }), true;
    }
    if (p === '/api/auth/refresh' && req.method === 'POST') {
      dash.refreshInFlight++;
      dash.maxRefreshInFlight = Math.max(dash.maxRefreshInFlight, dash.refreshInFlight);
      // A little latency, so two refreshes sent together would overlap.
      setTimeout(() => {
        dash.refreshInFlight--;
        dash.refreshes++;
        const r = cookie(req, `mc_refresh_${hostPort(req)}`);
        const row = r && dash.refresh.get(r);
        if (!row) return send(res, 401, { error: 'no_refresh_cookie', code: 'no_refresh_cookie' });
        if (row.used) {
          dash.reuse++;
          for (const k of dash.sessions.keys()) dash.sessions.delete(k);
          return send(res, 401, { error: 'refresh_chain_revoked', code: 'refresh_chain_revoked' });
        }
        row.used = true;
        issue(res, req, 200, { ok: true });
      }, 150);
      return true;
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      dash.logouts++;
      const t = sessionOf(req);
      if (t) dash.sessions.delete(t);
      const port = hostPort(req);
      send(res, 200, { ok: true }, { 'set-cookie': [`mc_token_${port}=; Path=/; Max-Age=0`, `mc_refresh_${port}=; Path=/api/auth; Max-Age=0`] });
      return true;
    }
    return false;
  }

  /** The /api/ws upgrade: 101 and one text frame when the session cookie is good. */
  function upgrade(req, socket) {
    const host = String(req.headers.host || '');
    if (!sessionOf(req) || (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    dash.wsOpens++;
    const msg = Buffer.from('hello from the mock gateway');
    socket.write(Buffer.concat([Buffer.from([0x81, msg.length]), msg]));
    socket.on('error', () => {});
  }

  return { dash, mintLink, handle, upgrade };
}
