// The gateway side of the app web origin (a remote crew's viewer), seen from the
// launcher, which runs on the gateway's machine.
//
// The relay serves `<app>.apps.localhost:<port>` only for the ports the gateway
// counts as dashboard ports: its own bound port plus KIROCREW_ALLOWED_LOOPBACK_PORTS
// (kiro_crew/apps/app_web_origin.py). A Remote Crew's tunnel reaches it on the
// hub's local port, which the remote gateway has not heard of, so the relay
// answers 421 until that port is added. `diagnose` asks the gateway exactly what
// the browser will ask it, from this machine, and says which of those it is;
// `addAllowedPort` writes the one line that fixes it.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

export const PORTS_VAR = 'KIROCREW_ALLOWED_LOOPBACK_PORTS';

/** A TCP port from a query value or JSON number, or 0. */
export function validPort(v) {
  const s = String(v ?? '').trim();
  if (!/^\d{1,5}$/.test(s)) return 0;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : 0;
}

/** The ports a `.env` file lists under KIROCREW_ALLOWED_LOOPBACK_PORTS (the last such line wins, as in a dotenv loader). */
export function listedPorts(text) {
  let ports = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${PORTS_VAR}\\s*=\\s*(.*?)\\s*$`).exec(raw);
    if (!m) continue;
    const value = m[1].replace(/^(["'])(.*)\1$/, '$2');
    ports = value.split(',').map((p) => validPort(p)).filter(Boolean);
  }
  return [...new Set(ports)];
}

/**
 * `text` with `port` added to the KIROCREW_ALLOWED_LOOPBACK_PORTS line (the line
 * is created when absent; other lines are untouched; a repeated assignment is
 * collapsed into the last one's place).
 * @returns {{text: string, changed: boolean, ports: number[]}}
 */
export function withAllowedPort(text, port) {
  const p = validPort(port);
  if (!p) throw new Error('not a TCP port');
  const lines = String(text || '').split(/\r?\n/);
  const re = new RegExp(`^\\s*(?:export\\s+)?${PORTS_VAR}\\s*=`);
  const ports = listedPorts(text);
  if (ports.includes(p)) return { text: String(text || ''), changed: false, ports };
  const next = [...ports, p];
  const line = `${PORTS_VAR}=${next.join(',')}`;
  let at = -1;
  lines.forEach((l, i) => {
    if (re.test(l)) at = i;
  });
  const kept = lines.filter((l, i) => !re.test(l) || i === at);
  if (at >= 0) kept[kept.indexOf(lines[at])] = line;
  else {
    while (kept.length && kept[kept.length - 1] === '') kept.pop();
    kept.push(line);
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  return { text: kept.join('\n') + '\n', changed: true, ports: next };
}

/** Add `port` to `<home>/.env` (owner-only, written whole through a temp file). */
export function addAllowedPort({ home, port, fs: fsi = fs }) {
  const p = validPort(port);
  if (!p) return { ok: false, error: 'not a TCP port' };
  if (!home) return { ok: false, error: 'no Kiro Crew data home (KIROCREW_HOME, or the home directory)' };
  const file = path.join(home, '.env');
  let existing = '';
  try {
    existing = fsi.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, file, error: `could not read ${file}: ${e.code || e.message}` };
  }
  const r = withAllowedPort(existing, p);
  if (!r.changed) return { ok: true, file, changed: false, ports: r.ports };
  try {
    fsi.mkdirSync(home, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fsi.writeFileSync(tmp, r.text, { mode: 0o600 });
    fsi.renameSync(tmp, file);
  } catch (e) {
    return { ok: false, file, error: `could not write ${file}: ${e.code || e.message}` };
  }
  return { ok: true, file, changed: true, ports: r.ports };
}

/** One GET to the gateway as the browser's request arrives: Host `<app>.apps.localhost:<port>`. */
export function askRelay({ gatewayPort, host, path: p, timeoutMs = 5000, http: h = http }) {
  return new Promise((resolve) => {
    const req = h.request({ host: '127.0.0.1', port: gatewayPort, method: 'GET', path: p, headers: { Host: host, Accept: 'text/plain' } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size <= 4096) chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve({ status: 0, body: '', error: 'response error' }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.code || e.message }));
    req.end();
  });
}

/**
 * Why the relay does or does not serve this app on `port`:
 *   ok                the relay reached the launcher (the probe answered with this run's id)
 *   port_not_allowed  421 on `port` but not on the gateway's own port: the port is not a dashboard port
 *   refused           421 on both: another reason (not a direct loopback request, the Session Manager listener)
 *   not_enabled       the gateway has no web origin for this app (not enabled, or the manifest lacks backend.webOrigin)
 *   gateway_unreachable / unexpected
 *
 * @param {object} o
 * @param {number} o.gatewayPort the gateway's own port on this machine
 * @param {string} o.appName
 * @param {number} o.port the port the browser reaches the dashboard on
 * @param {string} o.probePath the launcher's probe path on its web origin
 * @param {string} o.instance this launcher run's id, which the probe answers
 */
export async function diagnose({ gatewayPort, appName, port, probePath, instance, ask = askRelay }) {
  const host = (n) => `${appName}.apps.localhost:${n}`;
  const answers = async (n) => {
    const r = await ask({ gatewayPort, host: host(n), path: probePath });
    return { ...r, ok: r.status === 200 && r.body.trim() === instance };
  };
  const mine = await answers(port);
  if (mine.ok) return { state: 'ok', port };
  if (mine.status === 0) return { state: 'gateway_unreachable', port, detail: mine.error || 'no answer' };
  if (mine.status === 421) {
    if (Number(port) === Number(gatewayPort)) return { state: 'refused', port, detail: 'the gateway refused its own port' };
    const own = await answers(gatewayPort);
    return own.ok ? { state: 'port_not_allowed', port } : { state: 'refused', port, detail: 'the gateway refused the request on its own port too' };
  }
  if (mine.status === 404) return { state: 'not_enabled', port };
  return { state: 'unexpected', port, detail: `HTTP ${mine.status}` };
}
