# Architecture and API

How the app, its launcher and the VS Code server fit together, the launcher's HTTP API, and why the launcher proxies the workbench.

## How it works

```
Kiro Crew dashboard  (http://localhost:5476, Electron)
 |
 |  app page: ui/vscode-pane-<version>.mjs, imported into the dashboard's React tree
 |   - an inset rounded card like the Sessions panel, with a slim toolbar:
 |     VS Code tabs, New tab, and one menu (status, Reload, Restart server,
 |     updates, the Kiro Crew tab's sign-in, the active file)
 |   - one <iframe src="http://127.0.0.1:<PORT>/vsc-<key>/?folder=...&vscpTab=<tab>">
 |     per tab that has been shown, kept on document.body and placed over the
 |     card, so they survive leaving the page; only the front tab's shows
 |     (?workspace=<file> in place of ?folder= when the folder holds a
 |     .code-workspace file)
 |   - signs VS Code's "Kiro Crew" tab in: mints a sign-in link with the
 |     dashboard's own session and hands it to the launcher
 |  composer chip: ui/vscode-pane-session-<version>.mjs (contributes.sessionControls)
 |   - opens (or brings back) the chat's own tab on its project folder;
 |     hidden inside the tab's chat
 |
 |  /apps/vscode-pane/api/*  (gateway proxy, signs X-KiroCrew-Proxy)
 v
backend/launcher.mjs  on 127.0.0.1:<PORT>   (Node built-ins only, supervised by the gateway)
 |   /health                 unsigned, for the gateway health check
 |   /api/session|tabs/*|state|open|restart|file-menu   HMAC-verified proxy calls
 |   /api/bridge/commands|events                 bridge secret, used by the extension
 |   /vsc-<key>/*  HTTP + WebSocket reverse proxy; adds the connection token,
 |                 the secret-storage cookies, the loopback webview endpoint and
 |                 the window's tab (configurationDefaults)
 |   /_vscode-cli/mint-key   the workbench's secret-storage key (frame port)
 |   http://<secret>.localhost:<kc port>/*   the Kiro Crew tunnel: the live
 |                 dashboard, HTTP + WebSocket, holding the tab's session
 |
 |  spawns and restarts                                  long poll + events
 v                                                            ^
node.exe out/server-main.js  on 127.0.0.1:<random>            |
  (official VS Code server, --connection-token-file,          |
   --server-base-path /vsc-<key>)                             |
   '- one remote extension host per window -- extension/kiro-crew-bridge ---'
        (also contributes the "Kiro Crew" webview view to the secondary side
         bar, which frames <tunnel>/embed/chat/<the tab's chat> or
         <tunnel>/embed/sessions)
```

The pieces, in order of a cold start:

1. The gateway starts `backend/launcher.mjs` with `PORT` and `KIROCREW_PROXY_SECRET`.
2. The launcher finds a server build: `serverDir` from config, then
   `data/server/<commit>`, then a development cache under `.cache/`. If none matches the commit printed by `code --version`, it asks
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
- With no `code` command on the machine (a headless Linux host, for example) the
  launcher has no commit to ask for, so it downloads nothing by itself. It stops
  with "VS Code server is not installed" and `/api/session` reports
  `action: "install-server"`; the page then shows a "Download VS Code server"
  button. The button POSTs `/api/install-server`, which asks
  `update.code.visualstudio.com/api/update/server-<os>-<arch>-web/stable/latest`
  for the latest stable build and its SHA-256, downloads and checks it, unpacks
  it into `data/server/<commit>` and starts it. A failed download leaves the
  button in place. `allowDownload: false` (or `VSCODE_PANE_NO_DOWNLOAD=1`)
  removes the button and the route answers 409. The latest stable build can be
  newer than the VS Code the bridge extension's proposed APIs were written for
  (1.146 at the time of writing).
- When retries stop, `/api/session` reports `status: "error"`,
  `autoRetry: false` and a message starting with "Stopped:". "Restart the VS
  Code server" in the menu (or "Try again") resets the budget and tries once more,
  including a new download.
- When the gateway never starts the launcher, the page's session request gets
  502 "has no reachable backend" and the page shows "The VS Code backend is not
  running" with a "Check again" button (`describeSessionError` in the core
  module). The usual cause is no `node` the gateway can find: it looks through
  nvm (`nvm which current` after `--no-use`, which finds nothing) and then its
  own `PATH`, so a node that only an interactive shell sees is not enough, and
  it logs `no node binary found` in `~/.kiro/crew/gateway.log`. The page cannot
  read that log, so the message names Node.js as the likely cause and says where
  to confirm it. Fix: put `node` on the gateway's `PATH`, then disable and
  re-enable the app.
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
60 s window), the format both Kiro Crew 0.13.0 and the 0.14.0 source
gateways send.

| Route | Purpose |
|---|---|
| `GET /health` | `{ok, status}`; unsigned |
| `GET /api/session` | status, error, `autoRetry`, `generation`, the tabs (`tabs: {list: [{id, folder, session, url}], active, fresh}`), bridge state |
| `POST /api/tabs/open` `{folder?, session?, reuse?}` | open a tab and bring it to the front: with `session` (a chat's key) the chat's tab, reused when open; with `reuse` a tab on the same folder that has no chat; otherwise a new tab. `folder` defaults to the workspace and must be a folder on this machine |
| `POST /api/tabs/activate` `{id}`, `POST /api/tabs/close` `{id}` | bring a tab to the front, or close it (the tab to its right takes its place) |
| `GET /api/state[?tab=<id>]` | bridge connected, active editor path and selection (with `tab`, that tab's window), last saved file |
| `POST /api/open` `{path, line?, column?, kind?, tab?}` | `kind` is `openFile` (default), `openFolder` or `revealInExplorer`; a file goes to `tab`, else the tab whose folder holds it, else the front tab, which comes to the front; a folder opens as a tab of its own. Waits up to 8 s for the extension's result |
| `POST /api/restart` | restarts the VS Code server process |
| `POST /api/file-menu` | target of the `Open in VS Code` row (`contributes.fileMenuItems`); answers with a link to the tab it used (`/apps/vscode-pane?tab=<id>`) |
| `GET /api/theme` | the stored Kiro Crew palette, the VS Code base theme and what the extension last applied |
| `POST /api/theme` `{kind, vars?}` | apply the Kiro Crew theme in VS Code, tier "palette" or "base" (see Theme) |
| `GET /api/chat/status[?probe=1]` | whether chat can run: gateway origin, app token, last error, the extension's chat registration, the last turn; `probe=1` also calls the gateway |
| `POST /api/chat/ask` `{prompt, tab?}` | open the front tab's Chat view and submit a prompt to Kiro Crew there |
| `POST /api/crew/view` `{action: "reveal", tab?}` or `{action: "move", to}` | open the front tab's "Kiro Crew" view, or move the view to `auxiliarybar`, `sidebar` or `panel` (`vscode.moveViews`) |
| `POST /api/kc/sign-in` `{url, via?}` or `{error, via?}` | hand the tunnel a sign-in link (the page's mint, or a paste), or report why the page could not mint one |
| `POST /api/kc/disconnect` | sign VS Code's Kiro Crew tab out (see "The Kiro Crew tab") |
| `GET /api/bridge/kc?tab=<id>` | the tunnel origin, sign-in state and what the window's Kiro Crew view frames for its tab (`embedPath`: `/embed/chat/<key>?sid=<key>` for a chat's tab, `/embed/sessions` otherwise); creates nothing; bridge header |
| `POST /api/bridge/kc/sign-in` `{url}`, `POST /api/bridge/kc/connect`, `POST /api/bridge/kc/disconnect` | the tab's paste field, Connect button and Disconnect action; bridge header |
| `POST /api/secret-probe` `{op: "set", value}` or `{op: "get"}` | store or read one fixed probe value in the bridge's own `context.secrets`; the smoke test uses it to prove secrets persist. Nothing else in secret storage is reachable |
| `GET /api/bridge/commands?wait=25&host=<id>` | extension long poll; each window gets its own commands; header `X-Kiro-Bridge-Secret` |
| `POST /api/bridge/events` | extension events (`hello` with the window's `tab`, `tab`, `editor`, ...); same header |
| `POST /api/bridge/chat` `{prompt, folder?, slot?}` | one chat turn; streams newline-delimited JSON parts back; with `slot`, a turn of a Kiro Crew session type session; same header |
| `GET /api/chat/prefs` | the app's chat preferences (`hideCopilotAgents`), what VS Code last reported and the Machine settings they produce |
| `POST /api/chat/prefs` `{hideCopilotAgents}` | change the VS Code setting through the extension; the setting's change comes back as an event and is applied |
| `POST /api/chat/open-session` `{slot}` | open one of the app's Kiro Crew sessions in VS Code's Chat |
| `GET /api/bridge/sessions` | the Kiro Crew sessions this app opened for VS Code chats (kept in `data/state/chat-sessions.json`); bridge header |
| `POST /api/bridge/sessions` `{folder, title}` | create a session's slot, named `vscode-<folder>-<hash>-<id>` and pointed at the folder; bridge header |
| `GET /api/bridge/sessions/history?slot=` | a session's history as request and response turns, rebuilt from the slot; bridge header |
| `POST /api/bridge/approve` | relay an approval answered in VS Code to `POST /api/chat/slots/{slot}/approve`; bridge header |
| `POST /api/bridge/question` | relay a question's answer to the slot's question route; bridge header |

`GET /api/session` also carries `crewView: {resolved, visible, at}`, the
tab's state as the bridge last reported it, and `kc: {available, connected,
accessExpiresAt, canRefresh, signedInAt, lastError, attempts, via,
connectRequests}`, the tunnel's sign-in state. It never carries the tunnel
origin or a cookie. Nothing here, and nothing the Kiro Crew view asks for,
creates a Kiro Crew session: see "Tabs" below.

It carries `webOrigin: {host, probe, gatewayPort}` for the page's choice of
route to the workbench: `probe` is the path the page loads from the frame port
to find out whether its browser can reach it, `host` names the app's web origin,
and `gatewayPort` is the dashboard's own port on this machine, which the page
puts in the port forward it suggests to a viewer that has no route (see "Using
the app on a Remote Crew").

Every `/api/bridge/*` call names its VS Code window (`X-Kiro-Bridge-Host`, one
id per extension host), and the native chat routes check the folder against
that window's own folders, so two VS Code windows keep their own sessions. The
bridge relays turns, approvals and questions only for slots the app minted for
that folder (`slotNameFor(folder)` plus `-` and 8 hex digits), whatever
`data/state/chat-sessions.json` says, and only VS Code's "Approve" button
approves; any other answer, a bare "yes" included, rejects.
