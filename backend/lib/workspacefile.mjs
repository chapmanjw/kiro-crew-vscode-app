// The `*.code-workspace` file a project folder holds. A tab on a folder that has
// one opens that workspace instead of the folder, the way VS Code's "Open
// Workspace from File" would (backend/launcher.mjs, lib/args.mjs workbenchUrl).

import fs from 'node:fs';
import path from 'node:path';

const SUFFIX = '.code-workspace';
// A name with at least one character before the suffix: VS Code reads the extension, and `.code-workspace` alone has none.
const WORKSPACE_FILE_RE = /^.+\.code-workspace$/i;
// Control characters and backslashes cannot be carried in the workbench's `workspace` query value as they are.
const ODD_NAME_RE = /[\\\u0000-\u001f\u007f]/;

const byName = (a, b) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/**
 * The workspace file directly inside `folder`, as an absolute path, or null.
 * Files only (a symlink to a file counts); nothing below the folder is read.
 * With several, the one named after the folder (`my-app/my-app.code-workspace`)
 * wins, else the first by name, so the same folder always gives the same file.
 * @param {string} folder
 * @param {{fsApi?: Pick<typeof fs, 'readdirSync'|'statSync'>}} [o]
 * @returns {string|null}
 */
export function findWorkspaceFile(folder, { fsApi = fs } = {}) {
  if (typeof folder !== 'string' || !folder) return null;
  let entries;
  try {
    entries = fsApi.readdirSync(folder, { withFileTypes: true });
  } catch {
    return null;
  }
  const isFile = (e) => {
    if (e.isFile()) return true;
    if (!e.isSymbolicLink()) return false;
    try {
      return fsApi.statSync(path.join(folder, e.name)).isFile();
    } catch {
      return false;
    }
  };
  const names = entries.filter((e) => WORKSPACE_FILE_RE.test(e.name) && !ODD_NAME_RE.test(e.name) && isFile(e)).map((e) => e.name).sort(byName);
  if (!names.length) return null;
  const own = `${path.basename(folder.replace(/[\\/]+$/, '')).toLowerCase()}${SUFFIX}`;
  return path.join(folder, names.find((n) => n.toLowerCase() === own) || names[0]);
}

/**
 * `findWorkspaceFile` with a short memory. The page asks for every tab's URL a
 * few times a second, and the answer only matters when a tab's frame loads.
 * @param {{ttlMs?: number, now?: () => number, find?: (folder: string) => string|null, max?: number}} [o]
 * @returns {(folder: string) => string|null}
 */
export function workspaceFileFinder({ ttlMs = 5000, now = () => Date.now(), find = findWorkspaceFile, max = 100 } = {}) {
  const seen = new Map(); // folder -> {at, file}
  return (folder) => {
    if (typeof folder !== 'string' || !folder) return null;
    const at = now();
    const hit = seen.get(folder);
    if (hit && at - hit.at < ttlMs) return hit.file;
    const file = find(folder);
    if (seen.size >= max) seen.clear();
    seen.set(folder, { at, file });
    return file;
  };
}
