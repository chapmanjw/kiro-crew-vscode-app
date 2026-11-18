// The "Download VS Code server" path: a machine with no `code` command asks the
// update service for the latest stable build instead of a named commit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { serverLatestMetadataUrl } from '../backend/lib/discovery.mjs';
import { provisionServer } from '../backend/lib/provision.mjs';
import { matchRoute } from '../backend/lib/router.mjs';

const COMMIT = '69047191fc427f2f92828279aae1d90d8eeda7ab';

test('serverLatestMetadataUrl names the latest stable web build for the platform', () => {
  assert.equal(serverLatestMetadataUrl('linux', 'arm64'), 'https://update.code.visualstudio.com/api/update/server-linux-arm64-web/stable/latest');
  assert.equal(serverLatestMetadataUrl('win32', 'x64'), 'https://update.code.visualstudio.com/api/update/server-win32-x64-web/stable/latest');
  assert.throws(() => serverLatestMetadataUrl('freebsd', 'x64'), /no VS Code server build/);
});

test('POST /api/install-server is a signed route', () => {
  assert.deepEqual(matchRoute('POST', '/api/install-server', null), { name: 'installServer', auth: 'proxy' });
  assert.deepEqual(matchRoute('GET', '/api/install-server', null), { error: 405 });
});

async function withUpdateService(meta, archive, fn) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/latest') {
      const origin = `http://127.0.0.1:${srv.address().port}`;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ...meta, url: `${origin}/server.tar.gz` }));
    }
    res.writeHead(200, { 'content-length': fs.statSync(archive).size });
    fs.createReadStream(archive).pipe(res);
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}/latest`);
  } finally {
    srv.close();
  }
}

test('provisionServer with no commit installs the build the update service names', { skip: process.platform === 'win32' && 'tar.gz fixture is built on POSIX' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vscp-install-'));
  try {
    const src = path.join(tmp, 'src', 'vscode-server-linux-x64-web');
    fs.mkdirSync(path.join(src, 'out'), { recursive: true });
    fs.writeFileSync(path.join(src, 'node'), 'x');
    fs.writeFileSync(path.join(src, 'out', 'server-main.js'), '//');
    const archive = path.join(tmp, 'server.tar.gz');
    const r = spawnSync('tar', ['-czf', archive, '-C', path.join(tmp, 'src'), 'vscode-server-linux-x64-web']);
    assert.equal(r.status, 0, String(r.stderr));
    const sha256hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    const dataDir = path.join(tmp, 'data');
    const seen = [];

    const dir = await withUpdateService({ version: COMMIT, sha256hash }, archive, (metadataUrl) =>
      provisionServer({ metadataUrl, dataDir, commit: null, allowHttp: true, onStatus: (m) => seen.push(m) }),
    );
    assert.equal(dir, path.join(dataDir, 'server', COMMIT));
    assert.ok(fs.existsSync(path.join(dir, 'out', 'server-main.js')));
    assert.ok(seen.includes('Unpacking VS Code server'));
    // Nothing is left behind next to the build.
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'server')), [COMMIT]);

    // A wrong checksum is refused and installs nothing.
    const other = path.join(tmp, 'data2');
    await assert.rejects(
      withUpdateService({ version: COMMIT, sha256hash: 'a'.repeat(64) }, archive, (metadataUrl) =>
        provisionServer({ metadataUrl, dataDir: other, commit: null, allowHttp: true }),
      ),
      /checksum mismatch/,
    );
    assert.deepEqual(fs.readdirSync(path.join(other, 'server')), []);

    // A reply that does not name a commit is refused.
    await assert.rejects(
      withUpdateService({ version: 'latest', sha256hash }, archive, (metadataUrl) =>
        provisionServer({ metadataUrl, dataDir: other, commit: null, allowHttp: true }),
      ),
      /no commit/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
