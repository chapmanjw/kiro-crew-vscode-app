# VS Code pane for Kiro Crew (`vscode-pane`)

A Kiro Crew App whose sidebar icon opens a page holding a complete VS Code: the
official VS Code server running on this machine, shown in an iframe, with
terminals, the Microsoft Marketplace, debugging and every built-in extension. A
small companion extension connects that VS Code back to the app, so Kiro Crew
can open a file at a line in VS Code and can see which file VS Code has open.

Status: prototype (0.3.1). Tested standalone on Windows 11 with Node
24.18 and VS Code server 1.146.0 against a stand-in dashboard; 0.2.0 was
installed into the live Kiro Crew 0.13.0-rc.1 desktop app and worked.

## How it works

```
Kiro Crew dashboard  (http://localhost:5476, Electron)
 |
 |  app page: ui/vscode-pane-0.3.1.mjs, imported into the dashboard's React tree
 |   - an inset rounded card like the Sessions panel, with a slim toolbar:
 |     status, folder, Reload, Restart server, "Open file", active-file readout
 |   - one <iframe src="http://127.0.0.1:<PORT>/vsc-<key>/?folder=..."> kept on
 |     document.body and placed over the card, so it survives leaving the page
 |  composer chip: ui/vscode-pane-session-0.3.1.mjs (contributes.sessionControls)
 |   - opens the page on the chat's project folder
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
| `POST /api/theme` `{kind, vars?}` | apply the Kiro Crew theme in VS Code, tier "palette" or "base" (see Theme) |
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
   Registering a provider does not publish its models: the workbench asks a
   vendor for them only on `selectLanguageModels` or the provider's change
   event (`languageModels.ts`, `registerLanguageModelProvider`). Until then the
   picker is empty and a plain message goes out with no model, which is why a
   first plain "Hello" used to fail while the second message worked (the
   failed request's own fallback had resolved the models by then). The bridge
   therefore fires the change event and calls
   `vscode.lm.selectChatModels({ vendor: 'kiro-crew' })` right after it
   registers the provider, before the participants, and the launcher sets
   `chat.defaultModel` to `kiro-crew` so new chats start on it. The
   participant never reads `request.model`; the failure happens in the
   extension host before any handler runs, so it cannot be caught there.
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
   it at the folder with `POST /api/chat/slots/{slot}/project` when its project
   differs, and sends the turn with `POST /api/chat`. The create runs on every
   turn rather than once per folder, because the "VS Code: <folder>" session
   can be closed or deleted in Kiro Crew at any time; for an open slot it
   changes nothing. If the slot disappears between the create and the send
   (a 404 or `slot_closed`), the launcher recreates it and sends once more. That answers with an SSE stream of slot rows,
   so no WebSocket is needed. Reply text streams as markdown, tool calls show
   as italic lines, a pending approval shows a note to approve it in Kiro Crew.
   Stopping the request in VS Code stops the turn with
   `POST /api/chat/slots/{slot}/stop`.
5. The app token is confined to `permissions.api`; chat needs `/api/chat`
   (which covers `/api/chat/slots/...`) and `/api/status` for the probe. When
   those are not approved, the gateway answers the app token with
   `403 {"error": "app token not permitted for this endpoint"}`. The launcher
   reports that as `permission: {denied: true, ...}` and an "approve the new API
   permissions" `reason` in `GET /api/chat/status`, as `chat: {code:
   "permission", message}` in `GET /api/session` (the page shows the message
   above the workbench), and as the error text in the VS Code Chat view. It
   probes `/api/status` once at start, so the note shows before anyone chats.
6. `POST /api/bridge/chat` runs a full Kiro Crew turn, with tools, so the
   launcher accepts only a folder that one of the window's workspace folders
   contains (or the default workspace when none is open). The extension reads
   `KIROCREW_VSCODE_BRIDGE_SECRET` and deletes it from the extension host's
   environment at load (it activates on `*`), so language servers, debug
   adapters, tasks and other extensions' child processes do not inherit it.

### Theme

The theme has two tiers. Tier "palette" is the Kiro Crew colours as
`workbench.colorCustomizations` on top of a stock base theme. Tier "base" is
the stock theme alone: Dark Modern or Light Modern (the 1.146 ids of Default
Dark Modern and Default Light Modern), picked by whether the Kiro Crew theme is
dark or light.

`POST /api/theme` takes `{kind: "dark"|"light", vars?: {"--bg": "#rrggbb", ...}}`.
Only the envelope can be refused with a 400: a body that is not an object, an
unknown top-level field, a missing or unknown `kind`, or more than 4 KB. A body
with only `{kind}` is valid and gives tier "base". So do vars that are missing,
malformed (not an object, an unknown variable name, a value that is not a hex
colour, no `--bg` or `--text`), or whose `--text` on `--bg` contrast is below
4.5:1; the reply's `theme.reason` says why. Known names are `--bg --surface
--panel --border --text --muted --accent` plus other dashboard names such as
`--card`, `--chrome`, `--bg-hover`, `--accent-hover`, `--ok`, `--warn` and
`--danger`, and every name the page sends (`THEME_VARS` in
`ui/vscode-pane-core-0.3.1.mjs`, including `--diff-*`, `--ring` and
`--search-highlight`). One unknown name drops the whole palette to tier "base",
so `test/contract.test.mjs` fails if the page's list grows a name the launcher
does not know.

In tier "palette" the launcher maps the colours to about 180
`workbench.colorCustomizations` entries covering the editor, side bar, activity
bar, title bar, status bar, panel, tabs, lists, inputs, buttons, focus borders,
chat and the terminal, deriving missing shades from the background, text and
accent. In tier "base" it sends no customizations, and both the server's
Machine settings and the user settings lose any earlier palette, so no stale
colours linger.

The launcher keeps the result in `data/state/theme.json` and seeds the base
theme (and the palette, in tier "palette") into the server's Machine settings,
so the first paint is already themed. The extension writes the user settings
with `ConfigurationTarget.Global` only when a value differs. Every new
extension host (a start, reload or remount) gets the theme once and reports
back what VS Code holds. `GET /api/session` carries `theme: {kind, tier}` and
`GET /api/theme` adds the reason.

### Browser-side state across remounts and restarts

VS Code in the browser keeps its layout, open editors and user settings in the
browser, per origin, and its workspace storage key includes the remote
authority `127.0.0.1:<port>`. The gateway gives the launcher a new `PORT` on
every start, so the workbench is served from a second listener whose port is
kept in `data/state/frame.json`. The next start binds the same port again (a
new one only if something else holds it), so the frame origin is unchanged.
The `/vsc-<key>` path key is new on every launcher run and never written to
disk: `data/` is readable by Kiro Crew agents, and the key with the port would
open the workbench, terminals included, without any Kiro Crew approval. A file
from an earlier 0.3.0 build that still holds a key is rewritten with the port
only. VS Code keys its browser state by origin, not by path, so a reload or
remount of the pane, a VS Code server restart and a launcher restart all
bring back the open editors (checked by the smoke test).

`GET /api/session` carries `instance`, a random id per launcher run, and the
page's frame key includes it. When the backend restarts while the dashboard
stays open (disable and enable, Update, a gateway restart), the page sees the
new run id and frame URL on its next poll and reloads the kept-alive frame by
itself; without that the old workbench would hold a connection token the new
server does not know.
After a remount the old extension host lingers until the server retires it, so
the bridge sends commands only to the extension host that said hello last.

### The page in the dashboard

- Card. The page draws itself as the same card as the Sessions panel:
  `bg-elevated` surface, 1px `--border`, `--radius-xl` (16px) corners,
  `--shadow-sm` (`website/src/components/listShell.ts` `LIST_SHELL_CLS`). It
  sits in `<main>` where the Sessions card does: flush with `<main>`'s left
  and top edges, which puts it 8px from the icon rail card (the rail's own
  `mx-2`) with its top level with the rail's, and 8px in from the right and
  bottom (the drawer's `pb-2`, the rail's `mb-2`). `<main>` has no padding of
  its own (`App.tsx`). The values are `CARD_MARGIN` in the core module. It also carries the
  `sidebar sidebar-inner` classes that card has, so a theme that retints the
  Sessions panel (for example `kiro-light`) retints this one too. The dashboard
  puts no header or padding around an app page (`AppPage.tsx` renders the
  bundle straight into `<main>`), so the page sizes itself to the space left in
  `<main>` whenever the layout changes.
- VS Code keeps running when you leave the page. The dashboard unmounts an app
  page whenever you go to another route, and an iframe taken out of the
  document is destroyed, which is why 0.2.0 started over each time. The iframe
  now lives in one element on `document.body`. While the page is mounted it is
  placed over the card's body and clipped to the card's rounded bottom corners.
  Placement runs on change, not every animation frame: a `ResizeObserver` on
  the card, its frame slot, `<main>` and the document element (window resize,
  side panels, zoom), window `resize`, capture-phase `scroll`, and a 500 ms
  fallback for a move nothing reports; each trigger asks for at most one
  placement in the next frame. While the page is not mounted the frame is
  hidden, not removed, and loses keyboard focus. It is reloaded only for
  another folder, the Reload button, a restarted server or a restarted
  backend (a new run id).
- VS Code chip in the chat composer. `contributes.sessionControls` adds a
  "VS Code" chip to the composer shelf, before the agent chip ("Ultra Mode")
  and the project chip. Kiro Crew mounts the control when the chip is clicked
  and hands it the chat's project folder (`session.cwd`); the control navigates
  to `/apps/vscode-pane?folder=<that folder>` and the page opens it. A chat with
  no project shows a short note and an "Open VS Code" button instead. The chip's
  glyph comes from the host's fixed set (`Package`), because session controls
  cannot use an app image: the chip renders `<AppIcon icon={sc.icon} size={13} />`
  with no `iconUrl` (`components/chat-input/ContextShelf.tsx` in 0.14, the same
  call in the shipped 0.13.0-rc.1 bundle), `AppIcon` maps names to eleven
  lucide icons, the backend's `SessionControlContribution` keeps only `id`,
  `entryPoint`, `label`, `icon` and `statusPath`, and the control's own
  component renders only in the popover, not on the chip. Showing the real
  VS Code mark there needs Kiro Crew to accept an `iconUrl` on session controls
  (kept by the manifest model, resolved under the app's `ui/`) and pass it to
  `AppIcon` in `ContextShelf.tsx`.
- Theme. On mount, on every dashboard theme change and after each server
  restart the page POSTs to `/apps/vscode-pane/api/theme`. The body always has
  `kind` (`"dark"` or `"light"`), taken in this order: the palette name on
  `data-theme` (`dracula-dark`, `kiro-light`), the SDK's `useTheme` mode (only
  when the attribute is really there, since the SDK reports `dark` when it is
  missing), the luminance of `--bg`, the OS colour scheme, then dark. It has
  `vars` (`{"--bg": "#rrggbb", ...}`) only for the tokens the page could read:
  each is resolved by the browser (including `color-mix()`), translucent ones
  are composited over `--bg`, and the list is `THEME_VARS` in
  `ui/vscode-pane-core-0.3.1.mjs`. When none can be read the body is `{kind}`
  alone, and the backend falls back to stock VS Code Default Dark or Default
  Light. The toolbar degrades the same way: every colour is the dashboard
  variable when set, and otherwise a Default Dark or Default Light colour picked
  by `kind`.

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

Update turns the app off until you turn it back on. When an update adds API
permissions, turning it on asks you to approve them, and the app's token
cannot use them until you do. 0.3.0 adds `/api/chat`, `/api/chat/slots` and
`/api/status` to 0.2.0's list; without them VS Code Chat cannot reach Kiro
Crew, and the page and `GET /api/chat/status` say so.

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
Chat view. A 403 from the mock with the gateway's out-of-scope text must
show as unapproved permissions in `/api/chat/status` and in the page, and a
chat session closed in the mock must be recreated with its project on the next
turn. It seeds a saved theme before the start and checks the Machine
settings, checks that the page's palette POST on mount replaces it as tier
"palette" and that the bridge writes it, posts a second palette and reads the workbench setting back through
the bridge and from the painted status bar, reloads the page and checks the
open editor comes back, then restarts the launcher on a new API port and checks
the frame keeps its origin and path and the editor is restored from the same
browser profile. Before that it restarts the launcher with the page still
open and checks that the page loads the new frame URL by itself and the
bridge reconnects. It stops the launcher with `taskkill /T /F` (what the gateway does
on Windows) and checks that every process from the run is gone and both ports
are free. It needs a local Chrome or Edge and installs `playwright-core` under
`.cache/smoke-deps` on first run; the page loads React from esm.sh, so it needs
network access. Screenshots land in `.cache/smoke/` (`workbench.png`,
`chat.png`, `after-restart.png`).

In a git worktree, which has no `.cache`, put a gitignored `dev-config.json`
in the worktree root naming the main checkout's server build (`serverDir`) and
the checkout whose `.cache/smoke-deps` has playwright-core (`smokeDepsRoot`),
so nothing is downloaded twice:

```
{ "serverDir": "<main>/.cache/serve-web/cli-data/serve-web/<commit>",
  "devCacheRoot": "<main>/.cache/serve-web/cli-data/serve-web",
  "smokeDepsRoot": "<main>" }
```

The smoke test and `stage.mjs` read it.

The stand-in dashboard also has the dashboard's shell geometry (a 42px top bar
row, the icon rail card `mx-2 mt-0 mb-2` in its 74px track, an unpadded,
scrolling `<main id="main-content">`),
a Dracula-style dark palette and a light one with the dashboard's token names,
a chat view whose composer shelf mounts the app's session control, and a router
that unmounts the page when you leave it. With it the smoke test checks the
card's radius and border, that it sits 8px from the rail card with its top and
bottom level with the rail's, and the frame's clip; that a first plain chat
message typed into the Chat view of a fresh profile right after the workbench
renders reaches Kiro Crew; that the palette is POSTed
on mount and again after switching to light and back, with every value as
`#rrggbb`; that a palette with no readable tokens POSTs `{kind}` alone (light
from a `*-light` name, dark from the OS scheme for an unnamed one) and the card
falls back to Default Light or Dark colours; that the frame is placed only a
few times a second while idle and still matches its slot after a window
resize and a layout shift; that leaving the page unmounts it while the iframe stays in the
document, hidden, and that coming back shows the same iframe element with no
new workbench load, no new extension-host hello and the same editor tab; and
that the composer chip lands on `/apps/vscode-pane?folder=<chat project>` and
VS Code opens that folder. `.cache/smoke/pane-dark.png` is the pane in the dark
palette. The pane then goes back to the workspace folder for the restart checks.

## Icon

`ui/icon.svg` (sidebar) and `assets/icon.png` (store, rendered from it) are the
real Visual Studio Code icon, copied from an installed VS Code
(`resources/app/out/media/code-icon.svg`), not the Code-OSS art. The icon is a
Microsoft trademark. Using it here is fine only for John's personal use on his
own machine; swap it for original art before any public release of this app.

## Known limits

- A chat message sent before VS Code's extension host has started and the
  bridge has published its model (about half a second after the bridge
  connects in the smoke runs) still has no model and fails with "Language
  model unavailable": VS Code takes the model from the picker when the message
  is submitted (`chatWidget.ts`, `getSelectedModelRequestOptions`) and does
  not wait for one. The model list is kept in memory only, so every new window
  has this short window. Sending again works.
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
- The kept-alive frame sits on `document.body` at `z-index: 2`, above the
  dashboard's `<main>` and below its popovers and dialogs (`z-50` and up). A
  dashboard element that overlaps the content area with a lower stacking order
  would be drawn under it. Checked in the stand-in only.
- Only one VS Code page per window: two dashboard windows each keep their own
  frame, and therefore their own workbench.
- Workspace trust stays on. A new folder opens in Restricted Mode until you
  trust it; the bridge declares support for untrusted workspaces so it keeps
  working.
- Telemetry is turned off with `--disable-telemetry`.
- Extension secrets (for example GitHub sign-in) use the browser's default
  secret storage, since the CLI's key-minting endpoint is not present. Not yet
  checked for persistence.
- Two open VS Code windows (two frames) share one command queue; the one that
  connected last receives the commands.
- The bridge secret leaves the extension host's environment when the bridge
  loads. A process an extension or VS Code itself starts before that (the
  bridge activates on `*`, early but not first) still inherits it, and the
  VS Code server process keeps it so each new extension host gets it; VS Code
  has no way to hand an environment variable to one extension only.
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
