// Sign the Kiro Crew tab in without a link from the page: the gateway's own
// local-owner bootstrap, GET /api/token/local.
//
// The page's way (POST /api/auth/mobile-link, the "Connect your phone" mint)
// is a governed capability that a deployment can switch off, and a gateway
// that does answers 403 governance_denied. /api/token/local is a different
// route (kiro_crew/dashboard/handlers/core_local_token.py). It issues an owner
// session token to a process that holds the gateway's local secret and that
// the gateway can prove is an ordinary host process or a backend it spawned
// itself, which this launcher is. The gateway records the mint against the app.
//
// The secret is read the way the gateway's own clients read it for a dial to
// 127.0.0.1 (config/loader_locations.py read_local_secret, run_marker.py
// read_listener_secret, and their JS twin website/electron/local-token.js):
//   1. run/gateway-<port>-<address>.secret for every bind address that covers
//      127.0.0.1 (127.0.0.1, 0.0.0.0). A listener entry exists only for the
//      generation that is running: a stale one carries another value and is
//      refused, never guessed at.
//   2. Only when the gateway published no listener entry at all (an older
//      gateway): run/gateway-<port>.secret. The home-wide .local_secret is not
//      read: it is last-writer-wins across gateways in one home, so it can
//      belong to a different gateway than the one this port reaches.
// The secret goes only to 127.0.0.1:<port>. It is never logged, stored or
// returned, and neither is the token this returns to its caller.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/** The `kirocrew token` default: a session this long, traded at once for a cookie session. */
export const LOCAL_TOKEN_TTL = '20h';
/** Bind addresses whose listener entry covers a dial to 127.0.0.1. */
export const V4_LOOPBACK_BINDS = Object.freeze(['127.0.0.1', '0.0.0.0']);

/** Kiro Crew's data home: KIROCREW_HOME, else ~/.kiro/crew. */
export function dataHome(env, homedir) {
  const explicit = String(env.KIROCREW_HOME || '').trim();
  if (explicit) return explicit;
  return homedir ? path.join(homedir, '.kiro', 'crew') : '';
}

function readSecretFile(file, fsi) {
  try {
    return String(fsi.readFileSync(file, 'utf8')).trim();
  } catch {
    return '';
  }
}

/**
 * The gateway secret for 127.0.0.1:<port>, or {secret:'', reason} when no secret
 * may be sent there. `reason` says why, for the log and the tab's message.
 */
export function readLocalSecret({ home, port, fs: fsi = fs }) {
  const p = Number(port);
  if (!home) return { secret: '', reason: 'no Kiro Crew data home (KIROCREW_HOME, or the home directory)' };
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { secret: '', reason: 'no gateway port' };
  const run = path.join(home, 'run');
  let entries;
  try {
    entries = fsi.readdirSync(run).filter((n) => n.startsWith(`gateway-${p}-`) && n.endsWith('.secret'));
  } catch (e) {
    // No run directory is a proven absence of listener entries; any other
    // failure leaves absence unproven, and an unproven absence refuses.
    if (e && e.code === 'ENOENT') entries = [];
    else return { secret: '', reason: `could not read ${run} (${(e && e.code) || 'error'})` };
  }
  if (entries.length > 0) {
    const covered = new Set();
    for (const bind of V4_LOOPBACK_BINDS) {
      const v = readSecretFile(path.join(run, `gateway-${p}-${bind}.secret`), fsi);
      if (v) covered.add(v);
    }
    if (covered.size === 0) return { secret: '', reason: `the gateway published listener secrets for port ${p}, none for 127.0.0.1` };
    // One generation writes one secret under every address it bound. Two values
    // mean a stale entry beside the live one, and nothing here can tell which.
    if (covered.size > 1) return { secret: '', reason: `conflicting listener secrets for 127.0.0.1:${p}` };
    return { secret: [...covered][0], reason: '' };
  }
  const perPort = readSecretFile(path.join(run, `gateway-${p}.secret`), fsi);
  if (perPort) return { secret: perPort, reason: '' };
  return { secret: '', reason: `no gateway secret for port ${p} under ${run}` };
}

/**
 * GET /api/token/local on 127.0.0.1:<port>. Resolves {ok:true, token} or
 * {ok:false, status, code, error}; never rejects, never echoes the secret.
 * `http` is injectable for tests.
 */
export function mintLocalToken({ port, secret, ttl = LOCAL_TOKEN_TTL, timeoutMs = 10_000, http: h = http }) {
  return new Promise((resolve) => {
    const finish = (r) => resolve(r);
    const req = h.request(
      { host: '127.0.0.1', port: Number(port), method: 'GET', path: `/api/token/local?ttl=${encodeURIComponent(ttl)}`, headers: { 'x-local-secret': secret, accept: 'application/json' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            body = null;
          }
          if (res.statusCode === 200 && body && typeof body.token === 'string' && body.token) return finish({ ok: true, status: 200, token: body.token });
          const code = body && typeof body.code === 'string' && /^[A-Za-z0-9_ -]{1,60}$/.test(body.code) ? body.code : '';
          finish({ ok: false, status: res.statusCode || 0, code, error: code || (body && typeof body.error === 'string' ? body.error.slice(0, 200) : `HTTP ${res.statusCode}`) });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => finish({ ok: false, status: 0, code: '', error: (e && (e.code || e.message)) || 'request failed' }));
    req.end();
  });
}

/**
 * Read the secret, mint a token, hand it to `signIn` (the tunnel's link
 * exchange). Resolves {ok, error?, code?}. `signIn` gets the bare token and
 * its result is returned as it is.
 */
export async function signInWithLocalToken({ env, homedir, port, signIn, fs: fsi = fs, http: h = http, ttl = LOCAL_TOKEN_TTL }) {
  const found = readLocalSecret({ home: dataHome(env, homedir), port, fs: fsi });
  if (!found.secret) return { ok: false, code: 'local_secret_unavailable', error: found.reason };
  const minted = await mintLocalToken({ port, secret: found.secret, ttl, http: h });
  if (!minted.ok) return { ok: false, code: minted.code || `local_token_${minted.status || 'unreachable'}`, error: `the gateway refused the local token (${minted.error})` };
  const r = await signIn(minted.token);
  return r.ok ? { ok: true } : { ok: false, code: 'local_token_exchange_failed', error: r.error || 'the gateway would not trade the local token for a session' };
}
