# VS Code pane for Kiro Crew (`vscode-pane`)

A Kiro Crew App whose sidebar icon opens a page holding a complete VS Code: the
official VS Code server running on this machine, shown in an iframe, with
terminals, the Microsoft Marketplace, debugging and every built-in extension. A
small companion extension connects that VS Code back to the app, so Kiro Crew
can open a file at a line in VS Code and can see which file VS Code has open.

Status: first prototype (0.1.0). Tested standalone on Windows 11 with Node
24.18 and VS Code server 1.146.0; not yet installed into a live Kiro Crew.

## How it works

```
Kiro Crew dashboard  (http://localhost:5476, Electron)
 |
 |  app page: ui/vscode-pane-0.1.0.mjs, imported into the dashboard's React tree
 |   - toolbar: status, folder, Reload, Restart server, "Open file", active-file readout
 |   - <iframe src="http://127.0.0.1:<PORT>/vsc-<key>/?folder=...">
 |
 |  /apps/vscode-pane/api/*  (gateway proxy, signs X-KiroCrew-Proxy)
 v
backend/launcher.mjs  on 127.0.0.1:<PORT>   (Node built-ins only, supervised by the gateway)
 |   /health                 unsigned, for the gateway health check
 |   /api/session|state|open|restart|file-menu   HMAC-verified proxy calls
 |   /api/bridge/commands|events                 bridge secret, used by the extension
 |   /vsc-<key>/*  HTTP + WebSocket reverse proxy; adds the connection token
 |
 |  spawns and restarts                                  long poll + events
 v                                                            ^
node.exe out/server-main.js  on 127.0.0.1:<random>            |
  (official VS Code server, --connection-token-file,          |
   --server-base-path /vsc-<key>)                             |
   '- remote extension host -- extension/kiro-crew-bridge ---'
```

The pieces, in order of a cold start:

1. The gateway starts `backend/launcher.mjs` with `PORT` and `KIROCREW_PROXY_SECRET`.
2. The launcher finds a server build: `serverDir` from config, then
   `data/server/<commit>`, then the R1-B probe cache under `.cache/` (dev
   only). If none matches the commit printed by `code --version`, it downloads
   `https://update.code.visualstudio.com/commit:<commit>/server-win32-x64-web/stable`
   (a ~245 MB zip) into `data/server/` and unpacks it with the `tar.exe` that
   ships with Windows.
3. It copies `extension/kiro-crew-bridge` into `data/extensions` (and registers
   it in `extensions.json`, which VS Code reads once it exists), writes a fresh
   random connection token to `data/run/connection-token`, and spawns the
   server directly with `node.exe out/server-main.js`. It does not use
   `code serve-web`, because that wrapper adds `X-Frame-Options: SAMEORIGIN`.
4. The server's environment carries `KIROCREW_VSCODE_BRIDGE_URL` and
   `KIROCREW_VSCODE_BRIDGE_SECRET`, and drops `KIROCREW_PROXY_SECRET`, `PORT`
   and any host `VSCODE_*` variables so VS Code terminals and extensions never
   see the app's proxy secret.
5. The page asks `GET /api/session` for the frame URL and shows a loading or
   error state until the server answers.
6. Opening the workbench starts the remote extension host, which loads the
   bridge. The bridge long-polls `/api/bridge/commands` and posts `hello`,
   `editor` (path and selection), `saved` and `result` events.

### Why the launcher proxies the workbench

The dashboard runs on `localhost` and the frame on `127.0.0.1` so dashboard
cookies stay out of VS Code. Those are different sites, so the browser drops
the `vscode-tkn` cookie that VS Code sets with `SameSite=Lax`, and the
workbench also needs the token in JavaScript for its WebSocket handshake
(`vscode/src/vs/workbench/browser/web.main.ts:327`). Framing the server
directly with `?tkn=` therefore fails. The launcher's proxy:

- serves the workbench only under an unguessable `/vsc-<key>` prefix (new per
  launcher start); every other path is a 404,
- adds `Cookie: vscode-tkn=<token>` to every forwarded request and WebSocket
  upgrade, and strips every cookie the browser sent,
- writes the token into the workbench configuration (`connectionToken`), and
  removes the server's `Set-Cookie` for it.

The VS Code server itself still refuses any request without the token (403).

### API

All `/api/*` routes except the bridge ones require a valid `X-KiroCrew-Proxy`
signature (`<ts>:hmac_sha256(secret, "ts:METHOD:/api/path?query:sha256(body)")`,
60 s window), the format both the installed 0.13.0-rc.1 and the 0.14.0 source
gateways send.

| Route | Purpose |
|---|---|
| `GET /health` | `{ok, status}`; unsigned |
| `GET /api/session?folder=<path>` | status, error, frame URL for that folder, bridge state |
| `GET /api/state` | bridge connected, active editor path and selection, last saved file |
| `POST /api/open` `{path, line?, column?, kind?}` | `kind` is `openFile` (default), `openFolder` or `revealInExplorer`; waits up to 8 s for the extension's result |
| `POST /api/restart` | restarts the VS Code server process |
| `POST /api/file-menu` | target of the `Open in VS Code` row (`contributes.fileMenuItems`) |
| `GET /api/bridge/commands?wait=25` | extension long poll; header `X-Kiro-Bridge-Secret` |
| `POST /api/bridge/events` | extension events; same header |

### Open in VS Code from Kiro Crew file menus

`app.json` declares one `contributes.fileMenuItems` row, "Open in VS Code", on
the file overflow menu, the tree context menu and folder rows. Kiro Crew POSTs
`{item_id, surface, path, kind}` to `/apps/vscode-pane/api/file-menu`; files
open in an editor tab, folders replace the workspace. The reply carries a toast
message and a link to the app page. The host does not navigate on its own, so
the user clicks the link or the sidebar icon to see VS Code.

## Install into Kiro Crew (local path)

1. Stage a clean copy. A local-path install copies the whole folder except
   `node_modules`, `.git`, `__pycache__`, `.venv` and `.kirocrew-deps`, so
   installing this repo directly would also copy `.cache` (about 1 GB):

   ```
   node scripts/stage.mjs
   ```

   This writes `.cache/stage/vscode-pane` with `app.json`, `assets`, `backend`,
   `extension`, `ui` and this README, plus a `dev-config.json` pointing at the
   cached server build when one exists (so the first start does not download).
2. In the dashboard open Apps, then the Sources menu, choose install from a
   local path and give the absolute path of `.cache/stage/vscode-pane`.
3. Enable the app and accept the trust prompt (a third-party app with a
   backend must be trusted).
4. Click the VS Code icon in the sidebar.

After editing the source, run `node scripts/stage.mjs` again and use Update on
the app in the App Store. Disable and enable alone re-uses the old installed
copy.

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

## Development and tests

```
node --test "test/*.test.mjs"     # unit tests (node:test)
node scripts/smoke.mjs            # end-to-end against the cached server build
node scripts/stage.mjs            # clean install copy
node scripts/smoke.mjs --app-root .cache/stage/vscode-pane   # same, from the staged copy
node scripts/render-icon.mjs      # re-render assets/icon.png from ui/icon.svg
```

The smoke test starts the launcher like the gateway would (random `PORT` and
proxy secret), checks auth refusals, waits for the server, checks the
workbench headers and a WebSocket 101 through the proxy, then loads the real UI
page in headless Chrome from a `http://localhost` stand-in dashboard that signs
proxy calls. It confirms the workbench renders in the cross-site frame, the
bridge connects, `/api/open` and the toolbar both open a file at a line, the
state readout follows, the file-menu route works, and a killed server is
restarted. It stops the launcher with `taskkill /T /F` (what the gateway does
on Windows) and checks that every process from the run is gone and both ports
are free. It needs a local Chrome or Edge and installs `playwright-core` under
`.cache/smoke-deps` on first run; the page loads React from esm.sh, so it needs
network access. The screenshot lands in `.cache/smoke/workbench.png`.

## Known limits

- Same machine only. The iframe points at `127.0.0.1`, which resolves on the
  viewing machine, so this works in the desktop app or a browser on the gateway
  host, not from another computer or through a tunnel. Fixing that needs
  WebSocket support in the Kiro Crew app proxy.
- License. The server build is Microsoft's VS Code Server, under the Visual
  Studio Code Server License Terms (https://aka.ms/vscode-server-license);
  the launcher passes `--accept-server-license-terms` on your behalf. It is
  meant for personal use on your own machine; do not redistribute builds.
  code-server (MIT, Open VSX) is the fallback if that becomes a problem.
- Webviews (Markdown preview, extension webviews) load from
  `https://*.vscode-cdn.net`, so they need internet access.
- Clipboard: keyboard copy and paste work in the frame, but context-menu Copy
  and Paste use the async clipboard API, which the dashboard's
  `Permissions-Policy: clipboard-*=(self)` and Electron's permission handler
  are expected to block in a cross-origin frame. Not yet tested in the desktop
  app.
- Keyboard shortcuts the dashboard or Electron handles first never reach VS Code.
- Workspace trust stays on. A new folder opens in Restricted Mode until you
  trust it; the bridge declares support for untrusted workspaces so it keeps
  working.
- Telemetry is turned off with `--disable-telemetry`.
- Extension secrets (for example GitHub sign-in) use the browser's default
  secret storage, since the CLI's key-minting endpoint is not present. Not yet
  checked for persistence.
- Two open VS Code windows (two frames) share one command queue; whichever
  polls first runs a command.
- macOS and Linux are declared in `app.json` and the code has the POSIX paths,
  but only Windows was tested.

## Next steps

1. Install into the live Kiro Crew 0.13.0-rc.1 desktop app from the staged
   copy and check the page height, focus, keyboard and clipboard inside the
   real dashboard.
2. Give the bridge an app token (`POST /api/apps/vscode-pane/token` with the
   proxy secret) so VS Code can call Kiro Crew directly, for example "send this
   selection to a chat" or opening a chat in the workspace folder.
3. Follow the active Kiro Crew chat's project folder, and add a chat side-panel
   tab (`contributes.panelTabs`) that shows VS Code's active file.
4. Navigate to the app page automatically after "Open in VS Code" if Kiro Crew
   adds a navigate action to `fileMenuItems` results.
5. Try the `window.browserAPI` native view if iframe focus or clipboard
   behaviour is not good enough in the desktop app.
