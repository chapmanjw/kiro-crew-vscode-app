// Smoke checks for the workbench's secret storage (backend/lib/secretkey.mjs):
// the serve-web secret-key cookies through the frame proxy, the mint endpoint,
// the server half on disk, and a secret stored through the bridge extension's
// context.secrets that must read back after a page reload and launcher
// restarts. Run by scripts/smoke.mjs.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

function post({ port, path: p, headers = {} }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', (e) => resolve({ status: 0, body: Buffer.from(e.message) }));
    req.end();
  });
}

const HALF_A = 'A'.repeat(43);
const HALF_B = 'B'.repeat(43);

/**
 * Cookies, mint endpoint, key file, then a secret stored through the bridge.
 * Returns the stored value for secretReadBack.
 */
export async function secretChecks({ page, api, check, rawRequest, framePort, wbPath, dataDir, value }) {
  // 1. The workbench page sets both cookies with attributes that work in the cross-site frame.
  const wb = await rawRequest({ port: framePort, path: wbPath });
  const sc = [].concat(wb.headers['set-cookie'] || []);
  const pathCookie = sc.find((c) => c.startsWith('vscode-secret-key-path='));
  const half = sc.find((c) => c.startsWith('vscode-cli-secret-half='));
  check(
    'the workbench page sets vscode-secret-key-path to the mint endpoint and an HttpOnly client half, both SameSite=None; Secure; Partitioned; Path=/',
    !!pathCookie && /^vscode-secret-key-path=\/_vscode-cli\/mint-key;/.test(pathCookie) && !/HttpOnly/i.test(pathCookie) &&
      !!half && /HttpOnly/.test(half) && /Max-Age=\d{7,}/.test(half) &&
      [pathCookie, half].every((c) => /SameSite=None/.test(c) && /; Secure/.test(c) && /Partitioned/.test(c) && /Path=\//.test(c)),
    JSON.stringify(sc.map((c) => c.replace(/=([A-Za-z0-9_-]{20,})/, '=<half>'))),
  );
  check('the mint path cookie carries no frame path key', !!pathCookie && !/vsc-/.test(pathCookie), pathCookie && pathCookie.split(';')[0]);

  // 2. The browser stored them, partitioned to the dashboard's site, and the frame sees only the path cookie.
  const wbFrame = page.frames().find((f) => f.url().startsWith(`http://127.0.0.1:${framePort}/vsc-`));
  const docCookie = wbFrame ? await wbFrame.evaluate(() => document.cookie).catch(() => '') : '';
  const jar = (await page.context().cookies(`http://127.0.0.1:${framePort}/`)).filter((c) => c.name.startsWith('vscode-'));
  const pageOrigin = new URL(page.url()).origin.replace(/:\d+$/, '');
  check(
    'in the cross-site frame the browser keeps both cookies, partitioned to the dashboard site; the frame reads only the path cookie',
    docCookie === 'vscode-secret-key-path=/_vscode-cli/mint-key' && jar.length === 2 && jar.every((c) => c.secure && c.sameSite === 'None' && c.partitionKey === pageOrigin) &&
      jar.find((c) => c.name === 'vscode-cli-secret-half')?.httpOnly === true,
    `document.cookie "${docCookie}"; jar ${JSON.stringify(jar.map((c) => ({ n: c.name, partition: c.partitionKey, httpOnly: c.httpOnly })))}`,
  );

  // 3. The mint endpoint: frame origin and client half only, POST only, stable per half.
  const origin = `http://127.0.0.1:${framePort}`;
  const ok1 = await post({ port: framePort, path: '/_vscode-cli/mint-key', headers: { origin, cookie: `vscode-cli-secret-half=${HALF_A}` } });
  const ok2 = await post({ port: framePort, path: '/_vscode-cli/mint-key', headers: { origin, cookie: `vscode-cli-secret-half=${HALF_A}` } });
  const okB = await post({ port: framePort, path: '/_vscode-cli/mint-key', headers: { origin, cookie: `vscode-cli-secret-half=${HALF_B}` } });
  const noHalf = await post({ port: framePort, path: '/_vscode-cli/mint-key', headers: { origin } });
  const foreign = await post({ port: framePort, path: '/_vscode-cli/mint-key', headers: { origin: 'http://localhost:5476', cookie: `vscode-cli-secret-half=${HALF_A}` } });
  const asGet = await rawRequest({ port: framePort, path: '/_vscode-cli/mint-key', headers: { cookie: `vscode-cli-secret-half=${HALF_A}` } });
  check(
    'POST /_vscode-cli/mint-key returns a stable 32-byte key per client half and refuses a missing half, a foreign Origin and GET',
    ok1.status === 200 && ok1.body.length === 32 && ok1.body.equals(ok2.body) && okB.status === 200 && !okB.body.equals(ok1.body) &&
      noHalf.status === 403 && foreign.status === 403 && asGet.status === 405,
    `ok ${ok1.status}/${ok1.body.length}B, same ${ok1.body.equals(ok2.body)}, other half differs ${!okB.body.equals(ok1.body)}, no half ${noHalf.status}, foreign ${foreign.status}, GET ${asGet.status}`,
  );

  // 4. The server half: in data/state, owner-only, never in the log, settings or an environment.
  const file = path.join(dataDir, 'state', 'secret-key-half');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  const logs = ['launcher.log', 'vscode-server.log'].map((f) => path.join(dataDir, 'logs', f)).filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const machine = fs.readFileSync(path.join(dataDir, 'server-data', 'data', 'Machine', 'settings.json'), 'utf8');
  let acl = 'n/a';
  let aclOk = true;
  if (process.platform === 'win32' && text) {
    const r = spawnSync('icacls', [file], { encoding: 'utf8', windowsHide: true });
    const aces = String(r.stdout || '').split(/\r?\n/).map((l) => l.replace(file, '').trim()).filter((l) => /:\(/.test(l));
    acl = aces.join(' | ');
    aclOk = aces.length === 1 && /:\(F\)$/.test(aces[0]) && !/Everyone|Users|Authenticated/i.test(acl) && !/\(I\)/.test(acl);
  }
  check(
    'the server half is 32 bytes in data/state/secret-key-half, owner-only, and appears in no log or settings file',
    /^[A-Za-z0-9_-]{43}$/.test(text) && aclOk && !logs.includes(text) && !machine.includes(text),
    `length ${text.length}; acl ${acl}`,
  );

  // 5. A secret stored through the extension's context.secrets is encrypted into the frame's localStorage.
  const set = await api('POST', '/api/secret-probe', { op: 'set', value });
  const got = await api('POST', '/api/secret-probe', { op: 'get' });
  const stored = wbFrame ? await wbFrame.evaluate(() => localStorage.getItem('secrets.provider') || '').catch(() => '') : '';
  check(
    "a secret stored with the bridge's context.secrets is persisted encrypted in the frame's localStorage (not in memory)",
    set.json && set.json.ok && got.json && got.json.value === value && stored.length > 60 && !stored.includes(value),
    `set ${set.json && set.json.ok}, get ${got.json && got.json.value === value}, localStorage ${stored.length} chars, plaintext there ${stored.includes(value)}`,
  );
  const bad = await api('POST', '/api/secret-probe', { op: 'set', value: 'x'.repeat(201) });
  check('POST /api/secret-probe refuses an oversized value', bad.status === 400, String(bad.status));
  return value;
}

/** Read the probe secret back after a reload or restart; waits for the bridge. */
export async function secretReadBack({ api, check, value, label }) {
  let got = null;
  const t = Date.now();
  while (Date.now() - t < 30_000) {
    got = (await api('POST', '/api/secret-probe', { op: 'get' }).catch(() => ({ json: null }))).json;
    if (got && got.ok && got.value === value) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  check(`the stored secret reads back ${label}`, !!got && got.ok && got.value === value, JSON.stringify(got && { ok: got.ok, same: got.value === value, empty: got.value === '', error: got.error }));
}
