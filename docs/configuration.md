# Configuration and server updates

## Configuration

Optional `data/config.json` in the installed app folder
(`~/.kiro/crew/apps/vscode-pane/data/config.json`), overridden by environment
variables:

| Key | Env | Default |
|---|---|---|
| `serverDir` | `VSCODE_PANE_SERVER_DIR` | discovered as above |
| `workspace` | `VSCODE_PANE_WORKSPACE` | your home folder |
| `codeCli` | `VSCODE_PANE_CODE_CLI` | `code` |
| `allowDownload` (false to forbid) | `VSCODE_PANE_NO_DOWNLOAD=1` | downloads allowed |
| (data dir) | `VSCODE_PANE_DATA_DIR`, `KIROCREW_APP_DATA_DIR` | `<app>/data` |

`VSCODE_PANE_ALLOW_UNSIGNED=1` lets `/api/*` run without a proxy secret for
standalone development. Logs are in `data/logs/launcher.log` and
`data/logs/vscode-server.log`.


## Server updates

The app updates the VS Code server only for a build it installed itself: a build it downloaded into `data/server`, either automatically or with "Download VS Code server". A build from `serverDir`, from the dev cache, or one that a `code` command pins to the user's own VS Code is left alone, and the menu shows no update controls for it.

"Check for updates" in the menu makes one request to the update service and changes nothing. When a newer stable build is out, a line under the toolbar and the menu offer "Update to <version>", and the menu button carries a badge. Updating downloads that exact build, checks its SHA-256, unpacks it next to the current one and restarts the server with it. The build it replaces stays until the new one is running, and is then removed. If the new build does not start after the launcher's three tries, it is removed, the previous build comes back by itself, and the line under the toolbar says so.

Nothing updates on its own. Newer builds can change the chat extension's proposed APIs (the extension was written for VS Code 1.146), so check the chat after an update. The record of installs is `data/state/server-build.json`. `VSCODE_PANE_UPDATE_BASE` moves the update service to a loopback stand-in; `test/serverupdate-e2e.test.mjs` runs this whole path with small fake builds.
