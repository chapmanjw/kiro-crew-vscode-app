// Download and unpack the VS Code server build with Node built-ins and the
// tar.exe that ships with Windows 10+ (bsdtar, reads zip and tar.gz).

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { isServerBuild } from './discovery.mjs';

/**
 * Whether a download may go to `url`. Only https, so a redirect cannot
 * downgrade the download to plain http. `allowHttp` exists for local tests.
 */
export function urlAllowed(url, { allowHttp = false } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' || (allowHttp && u.protocol === 'http:');
}

function get(url, { allowHttp, maxRedirects, timeoutMs }, onResponse, reject) {
  const step = (u, left) => {
    if (!urlAllowed(u, { allowHttp })) return reject(new Error(`refusing non-https download URL ${new URL(u).protocol}//${new URL(u).host}`));
    const mod = u.startsWith('https:') ? https : http;
    const req = mod.get(u, { headers: { 'user-agent': 'kiro-crew-vscode-pane' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (left <= 0) return reject(new Error('too many redirects'));
        return step(new URL(res.headers.location, u).toString(), left - 1);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`download failed: HTTP ${res.statusCode}`));
      }
      onResponse(res);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('download timed out')));
    req.on('error', reject);
  };
  step(url, maxRedirects);
}

/** GET a small JSON document (https only unless allowHttp). */
export function fetchJson(url, { allowHttp = false, maxRedirects = 5, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    get(url, { allowHttp, maxRedirects, timeoutMs }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 1024 * 1024) res.destroy(new Error('metadata too large'));
        else chunks.push(c);
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(new Error(`bad metadata JSON: ${e.message}`));
        }
      });
      res.on('error', reject);
    }, reject);
  });
}

/**
 * GET `url` into `dest`, following up to 5 https redirects. With
 * `expectedSha256` the file is hashed while it streams and a mismatch fails
 * the download (and deletes the file).
 */
export function downloadFile(url, dest, { onProgress, maxRedirects = 5, timeoutMs = 60_000, allowHttp = false, expectedSha256 } = {}) {
  return new Promise((resolve, reject) => {
    get(url, { allowHttp, maxRedirects, timeoutMs }, (res) => {
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(dest);
      res.on('data', (c) => {
        received += c.length;
        hash.update(c);
        onProgress?.(received, total);
      });
      res.pipe(out);
      out.on('finish', () =>
        out.close(() => {
          const sha256 = hash.digest('hex');
          if (expectedSha256 && sha256.toLowerCase() !== String(expectedSha256).toLowerCase()) {
            fs.rmSync(dest, { force: true });
            return reject(new Error(`checksum mismatch: expected ${expectedSha256}, got ${sha256}`));
          }
          resolve({ bytes: received, sha256 });
        }),
      );
      out.on('error', reject);
      res.on('error', reject);
    }, reject);
  });
}

export function tarCommand(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const sys = path.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sys)) return sys;
  }
  return 'tar';
}

export function extractArchive(archive, destDir, { tar = tarCommand() } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const p = spawn(tar, ['-xf', archive, '-C', destDir], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${err.trim()}`))));
  });
}

/** The build root inside an unpacked archive: itself or its single child folder. */
export function locateBuildRoot(dir, exists = fs.existsSync, platform = process.platform) {
  if (isServerBuild(dir, exists, platform)) return dir;
  for (const name of fs.readdirSync(dir)) {
    const child = path.join(dir, name);
    if (isServerBuild(child, exists, platform)) return child;
  }
  return null;
}

/**
 * Fetch the server build for `commit` into `<dataDir>/server/<commit>`.
 * Staged under a temp name and renamed into place so a half-unpacked build is
 * never picked up by discovery.
 */
export async function provisionServer({ metadataUrl, dataDir, commit, onStatus, allowHttp = false }) {
  const root = path.join(dataDir, 'server');
  const final = path.join(root, commit);
  fs.mkdirSync(root, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  const archive = path.join(root, `.download-${stamp}.zip`);
  const staging = path.join(root, `.staging-${stamp}`);
  try {
    // The update service answers with the archive URL and its SHA-256.
    onStatus?.('Looking up VS Code server download');
    const meta = await fetchJson(metadataUrl, { allowHttp });
    if (!meta || typeof meta.url !== 'string' || !/^[0-9a-f]{64}$/i.test(meta.sha256hash || '')) {
      throw new Error('update service returned no download URL or SHA-256');
    }
    if (meta.version && meta.version !== commit) throw new Error(`update service returned commit ${meta.version}, expected ${commit}`);
    let last = 0;
    await downloadFile(meta.url, archive, {
      allowHttp,
      expectedSha256: meta.sha256hash,
      onProgress: (got, total) => {
        const now = Date.now();
        if (now - last > 1000) {
          last = now;
          onStatus?.(`Downloading VS Code server ${total ? Math.round((got / total) * 100) + '%' : Math.round(got / 1e6) + ' MB'}`);
        }
      },
    });
    onStatus?.('Unpacking VS Code server');
    await extractArchive(archive, staging);
    const buildRoot = locateBuildRoot(staging);
    if (!buildRoot) throw new Error('downloaded archive does not contain a VS Code server build');
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(buildRoot, final);
    return final;
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
