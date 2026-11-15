// The workbench's secret storage key, the scheme `code serve-web` uses
// (vscode/cli/src/commands/serve_web.rs:64-71, :254-289, :501-548).
//
// Why: the web workbench encrypts extension secrets (GitHub sign-in, the
// context.secrets of every extension) into localStorage only when the page
// carries a readable `vscode-secret-key-path` cookie naming a mint endpoint
// (vscode/src/vs/code/browser/workbench/workbench.ts:618-633). Without it, and
// with a remote authority (always true here), `secretStorageProvider` is
// undefined, BrowserSecretStorageService falls back to its in-memory base
// class (workbench/services/secrets/browser/secretStorageService.ts:24-33,
// platform/secrets/common/secrets.ts:227-237), and every secret is gone after
// a reload. Extensions survive because they live on the server.
//
// The key the workbench gets from POST <mint path> is
// sha256(server half || client half): the server half is 32 random bytes kept
// in the app's data dir, the client half 32 random bytes held by the browser
// in an HttpOnly cookie. The workbench XORs it with a per-value random key and
// encrypts with AES-GCM (workbench.ts ServerKeyedAESCrypto).
//
// Differences from serve-web, all because the workbench is a cross-site frame
// (http://127.0.0.1:<frame port> inside the dashboard on http://localhost):
//   - SameSite=None; Secure; Partitioned instead of SameSite=Strict. Strict
//     and Lax cookies are neither stored nor sent in a cross-site frame.
//     Chromium accepts Secure on http://127.0.0.1 and http://localhost, which
//     are potentially trustworthy origins. Partitioned (CHIPS) keys the cookie
//     to the top-level site, so it still works when third-party cookies are
//     blocked, and a page on another site never sees it.
//   - The mint path sits outside the /vsc-<key> prefix (`MINT_PATH`). The path
//     cookie is a plain cookie the browser keeps on disk, and the path key must
//     never be written to disk (README, browser-side state). Minting without
//     the HttpOnly client half yields nothing (the launcher refuses), and the
//     endpoint also refuses a foreign Origin, so the prefix adds no protection
//     there.
//   - The client half lives 400 days (Chromium's cap) and is re-sent with every
//     workbench page, so it slides; serve-web uses 30 days.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const KEY_BYTES = 32;
export const MINT_PATH = '/_vscode-cli/mint-key';
export const PATH_COOKIE = 'vscode-secret-key-path';
export const CLIENT_COOKIE = 'vscode-cli-secret-half';
export const CLIENT_MAX_AGE = 400 * 24 * 60 * 60;
const COOKIE_ATTRS = 'Path=/; SameSite=None; Secure; Partitioned';

/** base64url of exactly KEY_BYTES bytes, or null. */
export function decodeKeyPart(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{43}=?$/.test(s)) return null;
  const b = Buffer.from(s.replace(/=$/, ''), 'base64url');
  return b.length === KEY_BYTES ? b : null;
}

export function encodeKeyPart(b) {
  return Buffer.from(b).toString('base64url');
}

export function newKeyPart() {
  return crypto.randomBytes(KEY_BYTES);
}

/** The key the workbench uses: sha256(server half || client half), 32 bytes. */
export function mintKey(serverHalf, clientHalf) {
  return crypto.createHash('sha256').update(serverHalf).update(clientHalf).digest();
}

/** The value of one cookie in a Cookie header, or ''. */
export function readCookie(header, name) {
  for (const part of String(header || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

/** The client half the browser sent, or null when it is missing or malformed. */
export function clientHalfFrom(cookieHeader) {
  return decodeKeyPart(readCookie(cookieHeader, CLIENT_COOKIE));
}

/**
 * Set-Cookie values for a workbench page: the mint path (readable by the
 * workbench script) and the client half (HttpOnly), keeping the half the
 * browser already has so earlier secrets still decrypt.
 */
export function secretCookies(existingClientHalf) {
  const half = existingClientHalf || newKeyPart();
  return [
    `${PATH_COOKIE}=${MINT_PATH}; ${COOKIE_ATTRS}`,
    `${CLIENT_COOKIE}=${encodeKeyPart(half)}; HttpOnly; Max-Age=${CLIENT_MAX_AGE}; ${COOKIE_ATTRS}`,
  ];
}

/**
 * Restrict a file to the current user. POSIX: mode 0600. Windows: drop the
 * inherited ACEs and grant only the current user (icacls). Same-user processes,
 * Kiro Crew agents included, can still read it; see the README.
 */
export function restrictToUser(file, { platform = process.platform, username = currentUser(), env = process.env } = {}) {
  if (platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
      return true;
    } catch {
      return false;
    }
  }
  if (!username) return false;
  // The gateway starts backends with a short environment, so icacls is found
  // by its full path rather than PATH.
  const root = env.SystemRoot || env.SYSTEMROOT || env.WINDIR || 'C:\\Windows';
  const icacls = path.join(root, 'System32', 'icacls.exe');
  const r = spawnSync(fs.existsSync(icacls) ? icacls : 'icacls', [file, '/inheritance:r', '/grant:r', `${username}:F`], { windowsHide: true, stdio: 'ignore' });
  return r.status === 0;
}

function currentUser() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || '';
  }
}

/**
 * The server half, created once and kept in `file` (base64url, one line).
 * A malformed file is replaced, which makes earlier secrets unreadable; the
 * workbench then drops them (workbench.ts LocalStorageSecretStorageProvider.load).
 */
export function loadServerHalf(file, { restrict = restrictToUser } = {}) {
  try {
    const b = decodeKeyPart(fs.readFileSync(file, 'utf8').trim());
    if (b) return { key: b, created: false };
  } catch {
    /* missing: create below */
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = newKeyPart();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, encodeKeyPart(key) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  const restricted = restrict(file);
  return { key, created: true, restricted };
}

/**
 * Whether a mint request may get the key. POST only (the workbench's fetch,
 * workbench.ts getServerKeyPart), a loopback Host, no Origin or the frame's
 * own origin, and a well-formed client half.
 */
export function mintAllowed({ method, host, origin, listenPort, clientHalf, isLoopbackHost }) {
  if (method !== 'POST') return { ok: false, status: 405, error: 'method not allowed' };
  if (!isLoopbackHost(host)) return { ok: false, status: 403, error: 'bad host' };
  if (origin) {
    const o = String(origin).toLowerCase();
    if (o !== `http://127.0.0.1:${listenPort}` && o !== `http://localhost:${listenPort}`) return { ok: false, status: 403, error: 'bad origin' };
  }
  if (!clientHalf) return { ok: false, status: 403, error: 'no client key half' };
  return { ok: true };
}
