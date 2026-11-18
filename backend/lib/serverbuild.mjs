// The VS Code server build the app installed, and the record of its installs.
//
// The app owns a build when the build sits in the app's own data folder or the
// app downloaded it, and no `code` command pins the server to the user's own
// VS Code. A build from serverDir or the dev cache is the user's to manage, so
// the app never offers to update it.
import fs from 'node:fs';
import path from 'node:path';
import { isServerBuild, PUBLIC_UPDATE_BASE } from './discovery.mjs';

export const COMMIT_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^\d+\.\d+\.\d+/;
const LOOPBACK_BASE_RE = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/;

/** The update service's base: the public one, or a loopback stand-in named by VSCODE_PANE_UPDATE_BASE (tests). */
export function updateBase(value) {
  const base = String(value || '').trim().replace(/\/+$/, '');
  return LOOPBACK_BASE_RE.test(base) ? base : PUBLIC_UPDATE_BASE;
}

/** Whether the app owns the active build. `codeCommit` is the commit a `code` command reports, or null. */
export function ownedBuild(build, codeCommit = null) {
  if (!build || (build.source !== 'data' && build.source !== 'download')) return false;
  return !codeCommit;
}

/** The build's own version from its product.json (such as 1.146.0), or null. */
export function buildName(dir, fsi = fs) {
  try {
    const version = JSON.parse(fsi.readFileSync(path.join(dir, 'product.json'), 'utf8')).version;
    return typeof version === 'string' && VERSION_RE.test(version) ? version : null;
  } catch {
    return null;
  }
}

function nameOrNull(value) {
  return typeof value === 'string' && VERSION_RE.test(value) ? value : null;
}

/** The install record, or null when the file is missing or is not a record this module wrote. */
export function readRecord(file, fsi = fs) {
  let v;
  try {
    v = JSON.parse(fsi.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || !COMMIT_RE.test(v.commit)) return null;
  const previous = v.previous && typeof v.previous === 'object' && COMMIT_RE.test(v.previous.commit)
    ? { commit: v.previous.commit, name: nameOrNull(v.previous.name) }
    : null;
  return {
    commit: v.commit,
    name: nameOrNull(v.name),
    installedAt: typeof v.installedAt === 'string' ? v.installedAt : null,
    via: typeof v.via === 'string' ? v.via : null,
    previous,
  };
}

/** Write the record in one step (a temporary file renamed over it), readable by this user only. */
export function writeRecord(file, rec, fsi = fs) {
  fsi.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fsi.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`, { mode: 0o600 });
  fsi.renameSync(tmp, file);
}

/** The folder of a build named by commit, when that folder is still a server build; else null. */
export function recordedDir({ dataDir, commit, exists = fs.existsSync, platform = process.platform }) {
  if (!COMMIT_RE.test(commit || '')) return null;
  const dir = path.join(dataDir, 'server', commit);
  return isServerBuild(dir, exists, platform) ? dir : null;
}

/** Whether the newest stable build differs from the installed one. */
export function decideUpdate({ installedCommit, latest }) {
  return { available: !!latest && COMMIT_RE.test(latest.commit || '') && latest.commit !== installedCommit };
}

/** The commit-named folders among `names` other than `keep`: the only folders the app may remove. */
export function removableBuilds(names, keep) {
  return names.filter((n) => COMMIT_RE.test(n) && n !== keep);
}
