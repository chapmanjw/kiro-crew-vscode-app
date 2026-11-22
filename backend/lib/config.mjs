// Configuration: where the app keeps its data, which VS Code server build to
// use and which folder VS Code opens first. Pure functions; the caller passes
// env and a file reader so tests need no real filesystem.

import path from 'node:path';

export const APP_NAME = 'vscode-pane';

/**
 * The app's persistent data directory.
 *
 * The Kiro Crew gateway keeps an app's data in `<app root>/data`
 * (kiro_crew/apps/hooks_integration.py: `app_dir(name) / "data"`), which
 * survives Update. It does not pass that path to a process backend, so we
 * derive it from the app root. `KIROCREW_APP_DATA_DIR` is honoured because a
 * relocated data home uses it (builtins/design_tweak/backend/server.py:149),
 * and `VSCODE_PANE_DATA_DIR` lets tests and the smoke script point elsewhere.
 */
export function resolveDataDir(env, appRoot) {
  const explicit = env.VSCODE_PANE_DATA_DIR || env.KIROCREW_APP_DATA_DIR;
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());
  return path.join(appRoot, 'data');
}

/** Parse `data/config.json`; a missing or broken file yields `{}`. */
export function parseConfig(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/**
 * Merge env overrides over the config file.
 * Returns { serverDir, workspace, codeCli, devCacheRoot, allowDownload }.
 */
export function effectiveConfig(fileConfig, env, { homedir, appRoot }) {
  const pick = (...vals) => vals.find((v) => typeof v === 'string' && v.trim())?.trim();
  return {
    serverDir: pick(env.VSCODE_PANE_SERVER_DIR, fileConfig.serverDir) || null,
    workspace: pick(env.VSCODE_PANE_WORKSPACE, fileConfig.workspace) || homedir,
    codeCli: pick(env.VSCODE_PANE_CODE_CLI, fileConfig.codeCli) || 'code',
    // Dev convenience only: a server build left in the dev cache.
    devCacheRoot:
      pick(env.VSCODE_PANE_DEV_CACHE, fileConfig.devCacheRoot) ||
      path.join(appRoot, '.cache', 'serve-web', 'cli-data', 'serve-web'),
    allowDownload: !(env.VSCODE_PANE_NO_DOWNLOAD === '1' || fileConfig.allowDownload === false),
  };
}
