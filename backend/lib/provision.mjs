// Download and unpack the VS Code server build with Node built-ins and the
// tar.exe that ships with Windows 10+ (bsdtar, reads zip and tar.gz).

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { isServerBuild } from './discovery.mjs';

/** GET `url` into `dest`, following up to 5 redirects. Reports progress via onProgress(received, total). */
export function downloadFile(url, dest, { onProgress, maxRedirects = 5, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const get = (u, left) => {
      const mod = u.startsWith('https:') ? https : http;
      const req = mod.get(u, { headers: { 'user-agent': 'kiro-crew-vscode-pane' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (left <= 0) return reject(new Error('too many redirects'));
          return get(new URL(res.headers.location, u).toString(), left - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`download failed: HTTP ${res.statusCode}`));
        }
        const total = Number(res.headers['content-length']) || 0;
        let received = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (c) => {
          received += c.length;
          onProgress?.(received, total);
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve({ bytes: received })));
        out.on('error', reject);
        res.on('error', reject);
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('download timed out')));
      req.on('error', reject);
    };
    get(url, maxRedirects);
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
export async function provisionServer({ url, dataDir, commit, onStatus }) {
  const root = path.join(dataDir, 'server');
  const final = path.join(root, commit);
  fs.mkdirSync(root, { recursive: true });
  const stamp = `${process.pid}-${Date.now()}`;
  const archive = path.join(root, `.download-${stamp}.zip`);
  const staging = path.join(root, `.staging-${stamp}`);
  try {
    let last = 0;
    await downloadFile(url, archive, {
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
