// Request authentication for the launcher API.

import crypto from 'node:crypto';

export const PROXY_HEADER = 'x-kirocrew-proxy';
export const BRIDGE_HEADER = 'x-kiro-bridge-secret';
const MAX_SKEW_S = 60;

function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Sign like the gateway does (kiro_crew/apps/routes_proxy.py, v1 header). */
export function signProxyRequest({ secret, ts, method, target, body }) {
  const bodyHash = crypto.createHash('sha256').update(body || Buffer.alloc(0)).digest('hex');
  const msg = `${ts}:${method}:${target}:${bodyHash}`;
  const sig = crypto.createHmac('sha256', secret).update(msg).digest('hex');
  return `${ts}:${sig}`;
}

/**
 * Verify the gateway's `X-KiroCrew-Proxy: <ts>:<hmac>` header.
 * The HMAC covers "ts:METHOD:/api/path?query:sha256(body)" keyed with
 * KIROCREW_PROXY_SECRET; the timestamp must be within 60 s. Same format in
 * the installed 0.13.0-rc.1 and source 0.14.0 gateways.
 */
export function verifyProxySignature({ secret, header, method, target, body, now = Date.now() }) {
  if (!secret || !header) return false;
  const m = /^(\d{1,12}):([0-9a-f]{64})$/.exec(String(header).trim());
  if (!m) return false;
  const ts = Number(m[1]);
  if (Math.abs(Math.floor(now / 1000) - ts) > MAX_SKEW_S) return false;
  const expected = signProxyRequest({ secret, ts: m[1], method, target, body });
  return safeEqual(expected, `${m[1]}:${m[2]}`);
}

export function checkBridgeSecret(expected, provided) {
  if (!expected || !provided) return false;
  return safeEqual(expected, provided);
}

export function randomSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}
