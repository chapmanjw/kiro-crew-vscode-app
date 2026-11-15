// Register the bundled bridge extension in VS Code's extensions dir.
//
// Once <extensions-dir>/extensions.json exists VS Code only loads the folders
// it lists (vscode/src/vs/platform/extensionManagement/common/
// extensionsProfileScannerService.ts), so copying a folder in is not enough
// after the first run. We upsert our entry in that file too.

export const BRIDGE_ID = 'kiro-crew.kiro-crew-bridge';

export function bridgeFolderName(version) {
  return `${BRIDGE_ID}-${version}`;
}

/** URI components for a file path, the shape VS Code stores (`URI.toJSON()`). */
export function fileUriComponents(fsPath) {
  let p = String(fsPath).replace(/\\/g, '/');
  if (/^[a-zA-Z]:/.test(p)) p = '/' + p[0].toLowerCase() + p.slice(1);
  return { $mid: 1, path: p, scheme: 'file' };
}

/**
 * Return a new extensions.json array with exactly one bridge entry.
 * @param {unknown} existing parsed extensions.json (anything non-array is treated as empty)
 */
export function upsertBridgeEntry(existing, { version, folderPath, folderName, now = Date.now() }) {
  const list = Array.isArray(existing) ? existing : [];
  const others = list.filter(
    (e) => !(e && e.identifier && String(e.identifier.id).toLowerCase() === BRIDGE_ID),
  );
  others.push({
    identifier: { id: BRIDGE_ID },
    version,
    location: fileUriComponents(folderPath),
    relativeLocation: folderName,
    metadata: { installedTimestamp: now, pinned: true, source: 'resource' },
  });
  return others;
}

/** Folder names of older bridge copies that can be removed. */
export function staleBridgeFolders(names, currentFolderName) {
  const prefix = BRIDGE_ID + '-';
  return names.filter((n) => n.toLowerCase().startsWith(prefix) && n !== currentFolderName);
}
