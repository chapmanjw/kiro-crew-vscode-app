// Find (or describe how to fetch) the official VS Code server build.

import path from 'node:path';

const COMMIT_RE = /^[0-9a-f]{40}$/;

/** `code --version` prints version, commit, arch on three lines. */
export function parseCodeVersion(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const commit = lines.find((l) => COMMIT_RE.test(l)) || null;
  const version = lines[0] && /^\d+\.\d+\.\d+/.test(lines[0]) ? lines[0] : null;
  return { version, commit };
}

export function nodeExeName(platform = process.platform) {
  return platform === 'win32' ? 'node.exe' : 'node';
}

/** A directory is a usable server build when it has its node and server-main.js. */
export function isServerBuild(dir, exists, platform = process.platform) {
  if (!dir) return false;
  return (
    exists(path.join(dir, nodeExeName(platform))) &&
    exists(path.join(dir, 'out', 'server-main.js'))
  );
}

/**
 * Pick a server build. Order: the configured path, the app data dir, the dev
 * cache left by the R1-B probe. Inside the data dir and the dev cache, a build
 * for `commit` wins; otherwise any build there is used (newest name first) so
 * the app still starts when the `code` CLI is missing.
 *
 * @param {object} o
 * @param {string|null} o.configured
 * @param {string} o.dataDir
 * @param {string|null} o.devCacheRoot
 * @param {string|null} o.commit
 * @param {(p:string)=>boolean} o.exists
 * @param {(p:string)=>string[]} o.listDirs
 * @returns {{dir:string, source:string, commit:string|null}|null}
 */
export function findServerBuild({ configured, dataDir, devCacheRoot, commit, exists, listDirs, platform = process.platform }) {
  if (configured) {
    if (isServerBuild(configured, exists, platform)) {
      return { dir: configured, source: 'configured', commit: null };
    }
  }
  const roots = [
    { root: path.join(dataDir, 'server'), source: 'data' },
    ...(devCacheRoot ? [{ root: devCacheRoot, source: 'dev-cache' }] : []),
  ];
  for (const { root, source } of roots) {
    if (commit) {
      const dir = path.join(root, commit);
      if (isServerBuild(dir, exists, platform)) return { dir, source, commit };
    }
  }
  for (const { root, source } of roots) {
    let names = [];
    try {
      names = listDirs(root).filter((n) => COMMIT_RE.test(n)).sort().reverse();
    } catch {
      names = [];
    }
    for (const name of names) {
      const dir = path.join(root, name);
      if (isServerBuild(dir, exists, platform)) return { dir, source, commit: name };
    }
  }
  return null;
}

/** Platform slug used by update.code.visualstudio.com for server builds. */
export function serverPlatformSlug(platform = process.platform, arch = process.arch) {
  const os = { win32: 'win32', linux: 'linux', darwin: 'darwin' }[platform];
  const cpu = { x64: 'x64', arm64: 'arm64' }[arch];
  if (!os || !cpu) return null;
  return `${os}-${cpu}`;
}

export function serverDownloadUrl(commit, platform = process.platform, arch = process.arch) {
  if (!COMMIT_RE.test(commit || '')) throw new Error('invalid commit id');
  const slug = serverPlatformSlug(platform, arch);
  if (!slug) throw new Error(`no VS Code server build for ${platform}/${arch}`);
  return `https://update.code.visualstudio.com/commit:${commit}/server-${slug}-web/stable`;
}
