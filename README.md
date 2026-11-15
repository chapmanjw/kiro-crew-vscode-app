# VS Code pane for Kiro Crew (`vscode-pane`)

A Kiro Crew App whose sidebar icon opens a page holding a complete VS Code: the
official VS Code server running on this machine, shown in an iframe, with
terminals, the Microsoft Marketplace, debugging and every built-in extension. A
small companion extension connects that VS Code back to the app, so Kiro Crew
can open a file at a line in VS Code and can see which file VS Code has open.

Status: prototype (0.2.0). Tested standalone on Windows 11 with Node
24.18 and VS Code server 1.146.0; not yet installed into a live Kiro Crew.

## How it works

```
Kiro Crew dashboard  (http://localhost:5476, Electron)
 |
 |  app page: ui/vscode-pane-0.2.0.mjs, imported into the dashboard's React tree
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
   only). If none matches the commit printed by `code --version`, it asks
   `https://update.code.visualstudio.com/api/versions/commit:<commit>/server-win32-x64-web/stable`
   for the archive URL and its SHA-256, downloads the ~245 MB zip over https
   only (a redirect to plain http is refused), checks the hash, and unpacks it
   into `data/server/` with the `tar.exe` that ships with Windows.
3. It copies `extension/kiro-crew-bridge` into `data/extensions` (and registers
   it in `extensions.json`, which VS Code reads once it exists), writes the
   connection token to `data/run/connection-token` (one random token per
   launcher run, reused across server restarts), and spawns the
   server directly with `node.exe out/server-main.js`. It does not use
   `code serve-web`, because that wrapper adds `X-Frame-Options: SAMEORIGIN`.
4. The server gets the user's own environment, not the gateway's. The gateway
   starts app backends with a short allowlist of variables, so on Windows the
   launcher rebuilds the logon environment the way Windows does: the
   `HKLM\...\Session Manager\Environment` values, then `HKCU\Environment`
   (user `Path` appended, other user values win), plus the per-session values
   that live in no registry key (`USERNAME`, `USERPROFILE`, `APPDATA`,
   `ProgramFiles(x86)` and the rest), with `%VAR%` expanded. Terminals in VS
   Code therefore see `PSModulePath`, `GOPATH` and other user variables. From
   the launcher's own environment only `KIROCREW_SPAWNED` and
   `KIROCREW_SPAWN_INSTANCE` are carried over; the bridge address and secret
   are added; `KIROCREW_PROXY_SECRET`, `PORT` and host `VSCODE_*` variables are
   never passed. Off Windows the launcher environment is used as before.
5. Terminals drop the gateway's tracking variables and the bridge variables.
   The launcher writes `terminal.integrated.env.windows|linux|osx` entries set
   to `null` into the server's Machine `settings.json`
   (`data/server-data/data/Machine/settings.json`), which deletes them from
   every integrated terminal. The server process keeps the tracking variables
   on purpose. On Linux the gateway's orphan reap vouches for a dead backend's
   process group by those variables, so they let it clean up an orphaned VS
   Code server; terminal shells run in their own pty session and are outside
   that group anyway, so dropping the variables there means nothing a user
   starts in a terminal is ever mistaken for the backend. On Windows the
   gateway stops a backend with a process-tree kill (`taskkill /T`) that
   follows parent process ids, not variables, so stopping the app still takes
   down the server, its extension host and any open terminals (the smoke test
   checks this).
6. The page asks `GET /api/session` for the frame URL and shows a loading or
   error state until the server answers.
7. Opening the workbench starts the remote extension host, which loads the
   bridge. The bridge says hello at once, long-polls `/api/bridge/commands` and
   posts `editor` (path and selection), `saved` and `result` events.

### Restarts and failures

- The frame URL (`/vsc-<key>`) and the connection token stay the same for the
  whole launcher run. A new server process cannot resume the old workbench
  session, because it does not know the workbench's reconnection token
  (`remoteExtensionHostAgentServer.ts:419-470` rejects it). So `/api/session`
  reports a `generation` that goes up each time a server becomes ready, the
  page polls it every 2 s while VS Code is shown, and it reloads the frame
  when the number changes. In the smoke test the bridge is back about 6 s
  after the server is killed, with no user action.
- A server that crashes after it was running is restarted with backoff (1 s
  up to 30 s), at most 5 times in 5 minutes.
- A server that starts but never answers is retried at most 3 times in 10
  minutes.
- A missing build or a failed or bad download is never retried on its own, so
  the 245 MB download is not repeated in a loop.
- When retries stop, `/api/session` reports `status: "error"`,
  `autoRetry: false` and a message starting with "Stopped:". "Restart server"
  in the toolbar (or "Try again") resets the budget and tries once more,
  including a new download.
- Open commands that VS Code has not picked up expire after 60 s, so opening
  VS Code later does not replay old requests.

### Why the launcher proxies the workbench

The dashboard runs on `localhost` and the frame on `127.0.0.1` so dashboard
cookies stay out of VS Code. Those are different sites, so the browser drops
the `vscode-tkn` cookie that VS Code sets with `SameSite=Lax`, and the
workbench also needs the token in JavaScript for its WebSocket handshake
(`vscode/src/vs/workbench/browser/web.main.ts:327`). Framing the server
directly with `?tkn=` therefore fails. The launcher's proxy:

- serves the workbench only under an unguessable `/vsc-<key>` prefix on its
  own frame port; every other path is a 404, and the API port serves no
  workbench at all,
- refuses any request whose `Host` is not a loopback name (DNS rebinding), and
  any WebSocket upgrade whose `Origin` is set and is not the frame's own
  `http://127.0.0.1:<port>`, so no other web page can open the workbench
  socket, the dashboard page included,
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
| `GET /api/session?folder=<path>` | status, error, `autoRetry`, `generation`, frame URL for that folder, bridge state |
| `GET /api/state` | bridge connected, active editor path and selection, last saved file |
| `POST /api/open` `{path, line?, column?, kind?}` | `kind` is `openFile` (default), `openFolder` or `revealInExplorer`; waits up to 8 s for the extension's result |
| `POST /api/restart` | restarts the VS Code server process |
| `POST /api/file-menu` | target of the `Open in VS Code` row (`contributes.fileMenuItems`) |
| `GET /api/theme` | the stored Kiro Crew palette, the VS Code base theme and what the extension last applied |
| `POST /api/theme` `{kind, vars}` | store a Kiro Crew palette and apply it in VS Code (see Theme) |
| `GET /api/chat/status[?probe=1]` | whether chat can run: gateway origin, app token, last error, the extension's chat registration, the last turn; `probe=1` also calls the gateway |
| `POST /api/chat/ask` `{prompt}` | open VS Code's Chat view and submit a prompt to Kiro Crew there |
| `GET /api/bridge/commands?wait=25&host=<id>` | extension long poll; header `X-Kiro-Bridge-Secret` |
| `POST /api/bridge/events` | extension events; same header |
| `POST /api/bridge/chat` `{prompt, folder?}` | one chat turn; streams newline-delimited JSON parts back; same header |

### VS Code Chat answered by Kiro Crew

VS Code's own Chat view talks to Kiro Crew instead of Copilot. Each request
runs as a turn in a real Kiro Crew chat session for the open folder, so the
agent, its tools, approvals and the history live in Kiro Crew.

1. The bridge extension contributes a default chat participant
   (`isDefault`, proposed API `defaultChatParticipant`) and a plain
   `@kirocrew` one. The proposal is allowed on this stable server by
   `--enable-proposed-api kiro-crew.kiro-crew-bridge`, which the server passes
   to the web workbench (`webClientServer.ts:446`). Extension participants
   win the default slot over the core Copilot setup agent
   (`chatAgents.ts`, `_preferExtensionAgent`).
2. It also registers a "Kiro Crew" language model (finalized
   `vscode.lm.registerLanguageModelChatProvider`). VS Code resolves a model
   for every chat request before calling any participant and only accepts a
   Copilot model as the implicit default (`extHostLanguageModels.ts`,
   `getLanguageModelForRequest`), so without it every request fails with
   "Language model unavailable" while Copilot is signed out. Kiro Crew shows
   up in the model picker; a direct call to the model is also answered by a
   Kiro Crew turn.
3. The launcher writes supported chat settings into the server's Machine
   settings. `chat.defaultToCopilotHarness` and
   `chat.editor.preferCopilotHarness` are turned off because 1.146 otherwise
   starts new chats in the Copilot agent host, which never reaches extension
   participants. `chat.mcp.autostart` is `never`, so VS Code does not stop each
   request to start MCP servers it found in other tools' configs. The Copilot
   sign-in buttons in the title bar and welcome page are hidden. No built-in
   extension is removed.
4. A request goes extension, `POST /api/bridge/chat`, launcher. The launcher
   trades `KIROCREW_PROXY_SECRET` for an app token at
   `POST /api/apps/vscode-pane/token` (header `X-App-Secret`), renews it 10
   minutes before the hour is up and once more after a 401 or 403, finds or
   creates the slot `vscode-<folder>-<hash>` with `POST /api/chat/slots`, points
   it at the folder with `POST /api/chat/slots/{slot}/project`, and sends the
   turn with `POST /api/chat`. That answers with an SSE stream of slot rows,
   so no WebSocket is needed. Reply text streams as markdown, tool calls show
   as italic lines, a pending approval shows a note to approve it in Kiro Crew.
   Stopping the request in VS Code stops the turn with
   `POST /api/chat/slots/{slot}/stop`.
5. The app token is confined to `permissions.api`; chat needs `/api/chat`
   (which covers `/api/chat/slots/...`) and `/api/status` for the probe.

### Theme

`POST /api/theme` takes the Kiro Crew dashboard's resolved CSS variables,
`{kind: "dark"|"light", vars: {"--bg": "#rrggbb", ...}}`. Only known variable
names are accepted (`--bg --surface --panel --border --text --muted --accent`
plus the other dashboard names such as `--card`, `--chrome`, `--bg-hover`,
`--accent-hover`, `--ok`, `--warn`, `--danger`), only hex colours, at most 4 KB,
and `--bg` and `--text` are required. The launcher keeps it in
`data/state/theme.json`, picks Dark Modern or Light Modern (the 1.146 ids of
Default Dark Modern and Default Light Modern) by `kind`, and maps the palette to
about 180 `workbench.colorCustomizations` entries covering the editor, side
bar, activity bar, title bar, status bar, panel, tabs, lists, inputs, buttons,
focus borders, chat and the terminal, deriving missing shades from the
background, text and accent. It seeds that into the server's Machine settings
so the first paint is already themed, and the extension writes it to the user
settings with `ConfigurationTarget.Global` only when a value differs. Every new
extension host (a start, reload or remount) gets the theme once and reports
back what VS Code holds.

### Browser-side state across remounts and restarts

VS Code in the browser keeps its layout, open editors and user settings in the
browser, per origin, and its workspace storage key includes the remote
authority `127.0.0.1:<port>`. The gateway gives the launcher a new `PORT` on
every start, so the workbench is served from a second listener whose port and
path key are kept in `data/state/frame.json`. The next start binds the same
port again (a new one only if something else holds it) and the frame URL is
unchanged. A reload or remount of the pane, a VS Code server restart and a
launcher restart all bring back the open editors (checked by the smoke test).
After a remount the old extension host lingers until the server retires it, so
the bridge sends commands only to the extension host that said hello last.

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
node scripts/smoke.mjs --minimal-env   # same, launcher started with only the gateway's env allowlist
node scripts/stage.mjs            # clean install copy
node scripts/smoke.mjs --app-root .cache/stage/vscode-pane   # same, from the staged copy
node scripts/render-icon.mjs      # re-render assets/icon.png from ui/icon.svg
```

The smoke test starts the launcher like the gateway would (random `PORT` and
proxy secret, plus the gateway's `KIROCREW_SPAWNED`/`KIROCREW_SPAWN_INSTANCE`),
checks auth refusals, waits for the server, checks the workbench headers, a
WebSocket 101 through the proxy, and the refusals for a foreign or dashboard
`Origin` and a non-loopback `Host`. It then loads the real UI page in headless
Chrome from a `http://localhost` stand-in dashboard that signs proxy calls. It
confirms the workbench renders in the cross-site frame, opens a real VS Code
terminal and checks (by name only, never printing values) that it sees
`PSModulePath`, `USERNAME`, `ProgramFiles(x86)` and a user variable such as
`GOPATH` and does not see the tracking, bridge or proxy variables, checks that
the server process itself still has the tracking variable, and that the bridge
connects. `/api/open` and the toolbar both open a file at a line, the state
readout follows, and the file-menu route works. A killed server is restarted
with the same frame URL and a new generation, the page reloads the frame on
its own, the bridge reconnects and `/api/open` works again. It also plays the Kiro Crew gateway with a mock
(`test/support/gateway-mock.mjs`): the launcher exchanges its secret for an app
token there, a prompt sent through `/api/chat/ask` must reach the mock from the
default Chat view with no `@` mention, and the mock's reply must show in the
Chat view. It seeds a saved theme before the start and checks the Machine
settings, posts a second palette and reads the workbench setting back through
the bridge and from the painted status bar, reloads the page and checks the
open editor comes back, then restarts the launcher on a new API port and checks
the frame keeps its origin and path and the editor is restored from the same
browser profile. It stops the launcher with `taskkill /T /F` (what the gateway does
on Windows) and checks that every process from the run is gone and both ports
are free. It needs a local Chrome or Edge and installs `playwright-core` under
`.cache/smoke-deps` on first run; the page loads React from esm.sh, so it needs
network access. Screenshots land in `.cache/smoke/` (`workbench.png`,
`chat.png`, `after-restart.png`). In a git worktree without its own `.cache`,
a gitignored `dev-config.json` with `serverDir` (the cached server build) and
`smokeDepsRoot` (a checkout whose `.cache/smoke-deps` has playwright-core) lets
the smoke run without downloading anything.

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
- Two open VS Code windows (two frames) share one command queue; the one that
  connected last receives the commands.
- Chat in a folder that is in Restricted Mode does not run: VS Code disables
  all language models until the folder is trusted.
- Chat relies on a proposed API (`defaultChatParticipant`) and on 1.146 chat
  settings (`chat.defaultToCopilotHarness`); a later VS Code build may rename
  them. Without the proposal the `@kirocrew` participant still answers.
- If you sign in to Copilot in this VS Code, its default participant competes
  with Kiro Crew's; which one wins the default slot depends on registration
  order.
- macOS and Linux are declared in `app.json` and the code has the POSIX paths,
  but only Windows was tested.

## Next steps

1. Install into the live Kiro Crew 0.13.0-rc.1 desktop app from the staged
   copy and check the page height, focus, keyboard and clipboard inside the
   real dashboard.
2. Follow the active Kiro Crew chat's project folder, and add a chat side-panel
   tab (`contributes.panelTabs`) that shows VS Code's active file.
3. Navigate to the app page automatically after "Open in VS Code" if Kiro Crew
   adds a navigate action to `fileMenuItems` results.
4. Try the `window.browserAPI` native view if iframe focus or clipboard
   behaviour is not good enough in the desktop app.
