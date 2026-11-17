# VS Code pane for Kiro Crew (`vscode-pane`)

A Kiro Crew App whose sidebar icon opens a page holding a complete VS Code: the
official VS Code server running on this machine, shown in an iframe, with
terminals, the Microsoft Marketplace, debugging and every built-in extension. A
small companion extension connects that VS Code back to the app, so Kiro Crew
can open a file at a line in VS Code and can see which file VS Code has open.

Status: prototype (0.5.5). Tested standalone on Windows 11 with Node
24.18 and VS Code server 1.146.0 against a stand-in dashboard; 0.2.0 was
installed into the live Kiro Crew 0.13.0-rc.1 desktop app and worked.

## How it works

```
Kiro Crew dashboard  (http://localhost:5476, Electron)
 |
 |  app page: ui/vscode-pane-0.5.5.mjs, imported into the dashboard's React tree
 |   - an inset rounded card like the Sessions panel, with a slim toolbar:
 |     status, folder, Kiro Crew, Reload, Restart server, "Open file", active-file readout
 |   - one <iframe src="http://127.0.0.1:<PORT>/vsc-<key>/?folder=..."> kept on
 |     document.body and placed over the card, so it survives leaving the page
 |   - signs VS Code's "Kiro Crew" tab in: mints a sign-in link with the
 |     dashboard's own session and hands it to the launcher
 |  composer chip: ui/vscode-pane-session-0.5.5.mjs (contributes.sessionControls)
 |   - opens the page on the chat's project folder; hidden inside the tab's chat
 |
 |  /apps/vscode-pane/api/*  (gateway proxy, signs X-KiroCrew-Proxy)
 v
backend/launcher.mjs  on 127.0.0.1:<PORT>   (Node built-ins only, supervised by the gateway)
 |   /health                 unsigned, for the gateway health check
 |   /api/session|state|open|restart|file-menu   HMAC-verified proxy calls
 |   /api/bridge/commands|events                 bridge secret, used by the extension
 |   /vsc-<key>/*  HTTP + WebSocket reverse proxy; adds the connection token,
 |                 the secret-storage cookies and the loopback webview endpoint
 |   /_vscode-cli/mint-key   the workbench's secret-storage key (frame port)
 |   http://<secret>.localhost:<kc port>/*   the Kiro Crew tunnel: the live
 |                 dashboard, HTTP + WebSocket, holding the tab's session
 |
 |  spawns and restarts                                  long poll + events
 v                                                            ^
node.exe out/server-main.js  on 127.0.0.1:<random>            |
  (official VS Code server, --connection-token-file,          |
   --server-base-path /vsc-<key>)                             |
   '- remote extension host -- extension/kiro-crew-bridge ---'
        (also contributes the "Kiro Crew" webview view to the secondary side
         bar, which frames <tunnel>/embed/chat/<the folder's slot>)
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
| `POST /api/crew/view` `{action: "reveal"}` or `{action: "move", to}` | open VS Code's "Kiro Crew" tab, or move the view to `auxiliarybar`, `sidebar` or `panel` (`vscode.moveViews`) |
| `POST /api/kc/sign-in` `{url, via?}` or `{error, via?}` | hand the tunnel a sign-in link (the page's mint, or a paste), or report why the page could not mint one |
| `POST /api/kc/disconnect` | sign VS Code's Kiro Crew tab out (see "The Kiro Crew tab") |
| `GET /api/bridge/kc?folder=&opened=1` | the tunnel origin, sign-in state and `/embed/chat` URL for the folder; with `opened=1` (the tab just showed) it also creates or reopens the folder's slot; bridge header |
| `POST /api/bridge/kc/sign-in` `{url}`, `POST /api/bridge/kc/connect`, `POST /api/bridge/kc/disconnect` | the tab's paste field, Connect button and Disconnect action; bridge header |
| `POST /api/secret-probe` `{op: "set", value}` or `{op: "get"}` | store or read one fixed probe value in the bridge's own `context.secrets`; the smoke test uses it to prove secrets persist. Nothing else in secret storage is reachable |
| `GET /api/bridge/commands?wait=25&host=<id>` | extension long poll; header `X-Kiro-Bridge-Secret` |
| `POST /api/bridge/events` | extension events; same header |
| `POST /api/bridge/chat` `{prompt, folder?, slot?}` | one chat turn; streams newline-delimited JSON parts back; with `slot`, a turn of a Kiro Crew session type session; same header |
| `GET /api/chat/prefs` | the app's chat preferences (`hideCopilotAgents`), what VS Code last reported and the Machine settings they produce |
| `POST /api/chat/prefs` `{hideCopilotAgents}` | change the VS Code setting through the extension; the setting's change comes back as an event and is applied |
| `POST /api/chat/open-session` `{slot}` | open one of the app's Kiro Crew sessions in VS Code's Chat |
| `GET /api/bridge/sessions` | the Kiro Crew sessions this app opened for VS Code chats (kept in `data/state/chat-sessions.json`); bridge header |
| `POST /api/bridge/sessions` `{folder, title}` | create a session's slot, named `vscode-<folder>-<hash>-<id>` and pointed at the folder; bridge header |
| `GET /api/bridge/sessions/history?slot=` | a session's history as request and response turns, rebuilt from the slot; bridge header |
| `POST /api/bridge/approve` | relay an approval answered in VS Code to `POST /api/chat/slots/{slot}/approve`; bridge header |
| `POST /api/bridge/question` | relay a question's answer to the slot's question route; bridge header |

`GET /api/session` also carries `crewSlot: {key, folder, title}`, the
folder's own Kiro Crew session that VS Code's Kiro Crew tab opens on,
`crewView: {resolved, visible, at}`, the tab's state as the bridge last
reported it, and `kc: {available, connected, accessExpiresAt, canRefresh,
signedInAt, lastError, attempts, via, connectRequests}`, the tunnel's sign-in
state. It never carries the tunnel origin or a cookie. Naming the slot does
not create it: the launcher creates or reopens it in Kiro Crew only when the tab
opens on that folder (`GET /api/bridge/kc?opened=1`), for an absolute folder
that exists and that the calling VS Code window has open. A session you close
in Kiro Crew therefore stays closed until you open the tab again.

Every `/api/bridge/*` call names its VS Code window (`X-Kiro-Bridge-Host`, one
id per extension host), and the native chat routes check the folder against
that window's own folders, so two VS Code windows keep their own sessions. The
bridge relays turns, approvals and questions only for slots the app minted for
that folder (`slotNameFor(folder)` plus `-` and 8 hex digits), whatever
`data/state/chat-sessions.json` says, and only VS Code's "Approve" button
approves; any other answer, a bare "yes" included, rejects.

The frame port also serves `POST /_vscode-cli/mint-key` (see "Secret storage"
below).

### Kiro Crew as a native VS Code chat session type (0.4.0)

0.4.0 gives VS Code's own Chat a "Kiro Crew" session type, the way the
Copilot CLI and ACP extensions add their own. Each VS Code chat of that type
is one Kiro Crew slot, named `vscode-<folder>-<hash>-<id>` and pointed at the
folder, so it also shows in the Kiro Crew sidebar with its transcript, agents
and approval policy.

- Rendering. Replies stream as markdown and thinking; Kiro Crew tool rows
  become native VS Code tool cards, completed at turn end from the persisted
  rows (`GET /api/chat/slots/{slot}`), because the turn's SSE stream carries a
  tool row's title only. Reopening a session or reloading the window rebuilds
  its history from the slot. The launcher side is `backend/lib/nativechat.mjs`,
  the extension side `extension/kiro-crew-bridge/sessions.js`.
- Approvals and questions. A pending approval opens VS Code's own confirmation
  card (the workbench tool `vscode_get_confirmation_with_options`); the answer
  goes to `POST /api/chat/slots/{slot}/approve` through
  `POST /api/bridge/approve`. A decision made in Kiro Crew instead clears the
  VS Code card, and questions work the same way. The session shows "needs
  input" while it waits.
- The approval grant. Answering for a session needs
  `permissions.sessionApproval: true` in `app.json` and your consent: after
  updating the app, re-enable it and choose "Enable and allow chat control".
  Without the grant the gateway answers 403 `session_approval_not_granted`,
  and VS Code shows a note to approve in Kiro Crew instead.
- Default for new chats. `kiroCrew.chat.hideCopilotAgents` (default on, an
  application setting) hides Copilot's own agents (the local Ask/Agent
  harness, Cloud and Copilot CLI) from the session-type picker, so a new chat
  and a first plain message go to Kiro Crew. Turn it off to bring them back;
  the launcher applies the change to the Machine settings live, and
  `POST /api/chat/prefs` changes it from the app side.
- Kiro Crew tab. `kiroCrew.openCrewChat` (Ctrl+Alt+K, the status bar "Crew"
  item and an editor title action) opens VS Code's "Kiro Crew" tab (see
  below). The 0.4.0 id `kiroCrew.toggleCrewChat` still runs it.
- Where VS Code lists it. The session target picker under the chat input
  (headed "Continue In" in this build) offers "Copilot" and "Kiro Crew", with
  Kiro Crew current, and the Agent Sessions sidebar ("Chat Agent Sessions:
  Show Agent Sessions Sidebar") lists each Kiro Crew chat as a "kirocrew
  session" under its date. The browser workbench has no separate Agents window;
  that sidebar is its equivalent. The session type is the app's own harness, so
  it does not depend on the Local harness VS Code plans to remove. The smoke
  test checks both and saves `session-target.png` and `agent-sessions.png`.
- Proposals. It runs on the 1.146 proposed APIs `chatSessionsProvider`,
  `chatParticipantAdditions`, `chatParticipantPrivate` and `chatProvider`,
  enabled for the bridge by `--enable-proposed-api`. The 0.3.1 default
  participant and the "Kiro Crew" language model described next stay as the
  fallback and still answer `@kirocrew` in other session types.

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
`ui/vscode-pane-core-0.5.5.mjs`, including `--diff-*`, `--ring` and
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
  The same margins hold with the nav collapsed to the icon rail or expanded
  to the sidebar: both are one `<nav>` with `mx-2 mt-0 mb-2 rounded-xl`
  (`shell/nav/navRail.tsx:457`) in a 74px or 236px grid track
  (`hooks/useRailWidth.ts:20-21`), the same in the 0.13.0-rc.1 bundle.
- Workbench edges (0.5.2). VS Code 1.146 turns its Modern UI on by default
  (`workbench.experimental.modernUI`), which draws the side bars and the bottom
  panel as floating cards with a 1px border, 8px corners and a 4px gutter on
  every edge facing window chrome, the status bar included
  (`browser/media/floatingPanels.css`). Inside this card that put a strip and
  a second rounded corner above the status bar. The gutter is also part of the
  layout code (`FLOATING_PANEL_MARGIN` and `getFloatingPanelOuterMargin`,
  `services/layout/browser/layoutService.ts`), so a stylesheet cannot take it
  away without the parts' content sizes going out of step. The launcher sets
  the supported switch instead, `window.density.layout: "compact"`, in the
  server's Machine settings (`backend/lib/layoutprefs.mjs`). Compact removes
  the gaps and corners between the parts as well as at the edges, so the parts
  meet with hairlines. A user setting still overrides it. The workbench fills
  the card body right inside the card's 1px border and is clipped to its 15px
  inner radius, so the card keeps the Sessions card's border and corners and
  VS Code's edges sit flush under them. The smoke measures 0 px from the
  secondary side bar to the status bar and from every outer part to the frame
  edges, checks the pixels for a second line inside the card's border, and
  saves `.cache/smoke/edges-bottom.png`.
- Toolbar. The strip is 45px tall including its 1px bottom border
  (`BAR_HEIGHT` in the core module). Kiro Crew centres panel headers 23px
  below the panel's outer top (`components/listShell.ts` `LIST_HEADER_CLS`),
  and the expanded sidebar draws a hairline under its header 45px below its
  outer top (1px border, `pt-2`, the 28px logo row, `mb-1.5`, `gap-0.5`;
  `navRail.tsx:149-154`, `railChrome.tsx`). With the card's 1px top border the
  toolbar's controls sit on the 23px line and its bottom border on that
  hairline. The earlier 34px strip put the border 11px above it.
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
  glyph comes from the host's fixed set (`Tag`, the closest to a code or markup glyph; see below), because session controls
  cannot use an app image: the chip renders `<AppIcon icon={sc.icon} size={13} />`
  with no `iconUrl` (`components/chat-input/ContextShelf.tsx` in 0.14, the same
  call in the shipped 0.13.0-rc.1 bundle), `AppIcon` maps names to eleven
  lucide icons, the backend's `SessionControlContribution` keeps only `id`,
  `entryPoint`, `label`, `icon` and `statusPath`, and the control's own
  component renders only in the popover, not on the chip. Showing the real
  VS Code mark there needs Kiro Crew to accept an `iconUrl` on session controls
  (kept by the manifest model, resolved under the app's `ui/`) and pass it to
  `AppIcon` in `ContextShelf.tsx`.
- The chip is hidden inside VS Code's Kiro Crew tab, where it would only open
  the VS Code you are already in, and stays on every normal
  Kiro Crew session. No supported way exists: in 0.13.0-rc.1 and the 0.14.0
  source a session control has no visibility or `when` field
  (`hooks/useSessionControls.ts` keeps `id`, `entryPoint`, `label`, `icon`,
  `statusPath`), a `statusPath` answer can only set `state` (`ok`, `warn`,
  `none`), `tooltip` and `detail` (`normalizeStatus`), the chip gets neither the
  slot nor the embedding context, and `ChatPanelProps` is `{slotKey,
  conversationOnly, expandSteps}`; `/embed/chat` renders the same composer.
  The fallback is a stylesheet the tunnel adds only to the dashboard HTML it
  serves to the tab (`chipHideCss` in `backend/lib/chipcss.mjs`): it hides
  `button[data-session-control-chip][aria-label="VS Code"]` whose icon `<svg>`
  has the class `lucide-tag`, and the chip row's wrapper when that was its
  only chip. The real dashboard never gets it. The host puts no app identity on
  the chip, so its label (the aria-label is the label alone, since this app
  declares no `statusPath`, `ContextShelf.tsx:117-148`) plus its icon is the
  narrowest stable match; another app's `Package` chip keeps showing. A Kiro
  Crew change that adds a per-surface visibility rule to session controls would
  replace this.
- Theme. On mount, on every dashboard theme change and after each server
  restart the page POSTs to `/apps/vscode-pane/api/theme`. The body always has
  `kind` (`"dark"` or `"light"`), taken in this order: the palette name on
  `data-theme` (`dracula-dark`, `kiro-light`), the SDK's `useTheme` mode (only
  when the attribute is really there, since the SDK reports `dark` when it is
  missing), the luminance of `--bg`, the OS colour scheme, then dark. It has
  `vars` (`{"--bg": "#rrggbb", ...}`) only for the tokens the page could read:
  each is resolved by the browser (including `color-mix()`), translucent ones
  are composited over `--bg`, and the list is `THEME_VARS` in
  `ui/vscode-pane-core-0.5.5.mjs`. When none can be read the body is `{kind}`
  alone, and the backend falls back to stock VS Code Default Dark or Default
  Light. The toolbar degrades the same way: every colour is the dashboard
  variable when set, and otherwise a Default Dark or Default Light colour picked
  by `kind`.

### The Kiro Crew tab in VS Code's right pane (0.5.0)

Kiro Crew's chat is a tab in VS Code's own secondary side bar, next to Chat
(and Claude Code, when it is installed), the way Claude Code adds its tab. The
tab shows Kiro Crew's own dashboard chat, served live by the gateway, so it is
the same code and the same session pane you use in Kiro Crew, with its session
tabs, tool cards, approvals, pickers and side panels. The docked column of
0.4.0 and the overlay tried during 0.5.0 development are both gone (research
R5).

- The tab. The bridge contributes `viewsContainers.secondarySidebar` `kiroCrew`
  with one webview view, `kiroCrew.chatView` (`extension/kiro-crew-bridge/crewview.js`).
  When the tunnel is signed in, the view is one full-size iframe on the tunnel
  origin at `/embed/chat/<the folder's slot>` (`App.tsx:597-608`, the embed
  route built for IDE side panels). Its CSP allows framing that origin only.
  Clicking the tab, Ctrl+Alt+K, the status bar "Crew" item, the editor title
  action and the page toolbar's "Kiro Crew" button open it.
- The tunnel (`backend/lib/kcproxy.mjs`). The launcher serves the gateway's
  dashboard on its own loopback origin, `http://<128-bit secret>.localhost:<kc port>`,
  for HTTP and WebSocket. The SPA is built for `/`, so it needs a whole origin.
  - Any other `Host` gets 421, so a page that does not know the name cannot
    load it. A foreign `Origin`, or a mutating request with no `Origin`, gets
    403.
  - Upstream, `Host` and `Origin` become `http://127.0.0.1:<kc port>`, the
    same-origin loopback form the gateway accepts (`origin.py:470-505`), and
    `X-Forwarded-For: 127.0.0.1` marks every request as proxied.
  - Responses: `Set-Cookie` is captured and stripped, `X-Frame-Options` and
    `Strict-Transport-Security` are dropped, `frame-ancestors` is replaced by
    the exact chain (the dashboard, the workbench `http://127.0.0.1:<frame port>`,
    the webview origins `http://*.localhost:<frame port>`), and
    `Referrer-Policy` is `no-referrer` because the host name is the
    capability.
  - Only origin-form request targets (`/path`) pass; anything else is 400, so
    an absolute-form `http://host/path` cannot slip past the path rules.
  - Refused before the gateway, any method (after decoding and collapsing the
    path): `/api/token/local`, `/api/logout`, `/api/auth/mobile-link`,
    `/api/tailnet/*`, the instance connect, refresh-token and embed-token
    routes, `/api/apps/*/token`, `/api/webhooks/tokens`,
    `/api/relay-viewer/token`, `/api/secrets*`, `/api/reveal`,
    `/api/connections/{mint,premint,oauth-clients}`, `/api/mcp/oauth/relay`,
    the `/api/kas-login` device, loopback, poll, cancel and logout steps, and
    the WhatsApp and Weixin QR pairing and unlink routes.
  - Readable but never changed from the tab (any method but GET, HEAD and
    OPTIONS is refused): `/api/shared-crew/*` (guest invites and their
    credentials), `/api/security/*` (credential redaction),
    `/api/crons/*/secrets`, `/api/whatsapp/config`, `/api/weixin/config` and
    `/api/config/*`. This is a deny list, not an allow list: the chat UI calls
    dozens of routes, and a new Kiro Crew release would add more, so an allow
    list would break the tab on the first update. `/sw.js` is 404, so the
    shell's service worker does not claim the origin.
  - Refreshes (`POST /api/auth/refresh`) run one at a time, so two tabs never
    replay a refresh token and revoke the chain.
  - The launcher log gets one line per request: method, path and status, never
    a query, body or cookie.
- Webviews from loopback. The frame proxy sets the workbench's
  `webviewEndpoint` to `http://{{uuid}}.localhost:<frame port>/vsc-<key>/<static route>/out/vs/workbench/contrib/webview/browser/pre/`
  and adds that origin to the workbench page's `frame-src`, which otherwise
  allows only `https://*.vscode-cdn.net` (`webClientServer.ts:152`). Every frame
  in the chain is then loopback, so Chromium's Local Network Access never sees
  a public origin reaching loopback. As a side effect every webview (Markdown
  preview, extension pages, Claude Code's tab) works offline. The smoke test
  checks the Markdown preview and that no webview loads from vscode-cdn.net.
  Webview URLs carry the frame key in their path, so the frame listener treats
  any `*.localhost` Host as a webview and serves it only GET or HEAD of the
  webview host files under `.../out/vs/workbench/contrib/webview/browser/pre/`;
  everything else is 403, `/vscode-remote-resource` (any file your account can
  read) and the workbench included, and webview origins never get a WebSocket.
  A webview's own resources load through its service worker and the workbench,
  not this listener.
- Signing the tab in. The tab needs a Kiro Crew session of its own; the
  launcher keeps it and the browser never sees it. Approval is by possession of
  a sign-in link, as for any other device (`docs/guides/remote-and-mobile.md`).
  There are four ways to get a session, in the order the app tries them:
  0. Local. The launcher is a backend the gateway spawned, and the gateway's
     local-owner bootstrap (`GET /api/token/local`, `handlers/core_local_token.py`)
     admits such a backend. At start, and again after a session ends on its
     own, the launcher reads the gateway's secret from `run/gateway-<port>-127.0.0.1.secret`
     under the Kiro Crew data home (`KIROCREW_HOME`, else `~/.kiro/crew`), the way
     the gateway's own clients do, asks the gateway for a token directly on
     loopback (never through the tunnel, which refuses that route) and trades
     it through the same `/api/auth/me?token=.` exchange. It needs no dashboard
     URL and does not use the mobile-link mint, which a deployment can switch
     off (403 `governance_denied`). It never sends the secret anywhere but
     `127.0.0.1:<gateway port>`, never logs it, and does not read the
     home-wide `.local_secret`. It honours Disconnect: only Connect or a paste
     signs in again. When the secret cannot be read or the gateway refuses it,
     the ways below still apply and the tab shows why in `kc.local`.
  1. Automatic. When the VS Code page opens and the tab is not signed in, the
     page, which runs inside the signed-in dashboard, calls the dashboard's own
     `POST /api/auth/mobile-link` (the "Connect your phone" link) with a plain
     same-origin `fetch`, so the dashboard's HttpOnly session cookie goes with
     it. It hands the link to the launcher (`POST /api/kc/sign-in`), which
     trades it for a session the way the dashboard's sign-in banner does
     (`GET /api/auth/me?token=…` through the tunnel). Nobody has to do anything.
     It runs at most once per page load, and again only after the session
     ended on its own (a 401: 30 idle days, `kirocrew logout`). A Disconnect is
     kept in `kc-session.json`, so no reload signs the tab in again until you
     press Connect or paste a link.
  2. Connect. The tab's Connect button asks the page (through the launcher) to
     do the same again.
  3. Paste. The tab has a field for a sign-in link from `kirocrew token` or the
     `/kirocrew dashboard` chat command. The dashboard's own "Sign in required"
     banner inside the tab works too.

  The gateway mints a mobile link only when Settings has a dashboard URL
  (`dashboard.url`), otherwise it answers 409 `external_origin_unavailable`
  (`handlers/auth_mobile.py:105-111`), and it refuses app tokens
  (`auth_mobile.py:83-88`). Only the link's `token` parameter is used, so a
  link minted for any origin of the same gateway works.

  A fresh Kiro Crew desktop install has no dashboard URL, and nothing else a
  signed-in dashboard page can call mints a sign-in link or a session: the
  mobile link takes no origin parameter (it reads only `app["dashboard_url"]`,
  set at boot, `server.py:920`), the tailnet QR needs Tailscale, the Remote Crew
  connect and embed-token routes mint from another machine's gateway over SSH,
  the desktop window gets its token from the local owner secret in Electron's
  main process, and the preload exposes no token API (`website/electron/preload.js`).
  The dashboard cannot set the URL either: the config PATCH refuses URL-valued
  keys (`handlers/config_all_settings.py`, `TEXT_EDIT_PATHS`), and the value
  takes effect only after a restart (`config/sections_dashboard.py`,
  `restart=True`). So when the mint answers 409, the page shows the one-time fix
  with a Copy button, `kirocrew config set dashboard.url <this dashboard's
  origin>` (`cli_parser_gateway.py:443`), and says to restart Kiro Crew; after
  that the tab signs in by itself every time. The tab's sign-in panel says the
  same and keeps the paste field. The app never changes your config. Setting
  `dashboard.url` to the loopback origin you already use keeps the gateway's
  port and adds no new CSRF origin; Kiro Crew also uses it in links it posts to
  Slack and other channels.
- What the session can do. It is a full owner dashboard session, the same user
  as the desktop window, because the chat UI needs dozens of routes and the full
  event stream; no narrower token runs it (R5 section 6.3). The gateway itself
  refuses this session the "direct local" features because every request is
  proxied: secret reveal, config writes, the host file picker and screenshot,
  and the external terminal. The tunnel refuses the credential-minting routes
  listed above. Anything else you can do in the Kiro Crew dashboard, you can do
  from the VS Code tab.
- Where it is kept. `data/state/kc-session.json`, owner-only (mode 0600, and on
  Windows an ACL with only your user), holds the tunnel's host name and port and
  the session and refresh cookie values. The access cookie lasts up to 1 hour
  and is refreshed by the dashboard code in the tab; the refresh cookie lasts 30
  days and slides. The tab therefore stays signed in across launcher, gateway
  and VS Code restarts for up to 30 idle days. When the gateway answers 401 on
  its session checks (`/api/auth/me`, `/api/auth/refresh`), the tunnel forgets
  the session, so the page's automatic sign-in or Connect can run again.
  Reading that file gives more than the tab has: a client that sends those
  cookies straight to the gateway, without the tunnel's X-Forwarded-For, counts
  as direct local and regains secret reveal and config writes. Any process
  running as you, Kiro Crew agents included, can read it; on a single-user
  machine a second key on disk would not change that.
- Disconnect. "Kiro Crew: Disconnect the Kiro Crew Tab" (the view's title
  action, or the command palette) and the page toolbar's Disconnect button
  call `POST /api/auth/logout` through the tunnel (that session only), delete
  the stored cookies and rotate the host name, so a frame still holding the
  old URL gets 421. The choice is kept until you press Connect or paste a link.
  `kirocrew logout` still ends every session everywhere. Pasting a new link
  while signed in logs the old session out.
  Signing out inside the tab works too: the tunnel applies the cookie deletion.
- The chip. Inside the tab the app's own "VS Code" composer chip is hidden: you
  are already in VS Code. No supported way exists (see the VS Code chip in "The
  page in the dashboard"), so the tunnel adds a stylesheet to the dashboard HTML
  it serves (`backend/lib/chipcss.mjs`). That copy exists only inside VS Code;
  the real dashboard is untouched. It hides the chip labelled "VS Code" whose
  icon `<svg>` has the class `lucide-tag`, and the chip row's wrapper when
  that was its only chip. Another app's `Package` chip keeps showing.
- Edges (0.5.1). The same stylesheet (`embedFlushCss`) pins the embed page to
  the webview: `html`, `body` and `#root`, the embed shell (`#root`'s child
  that holds `[data-chat-scope]`), every box down to the outermost chat pane,
  and that pane get no margin, border, radius or shadow, and the shell is sized
  to 100% rather than `100vw`/`100vh`. It also cancels the pane's inline
  `margin-left: -8px`, which the dashboard sets while the sessions sidebar is
  closed (`ChatPage.tsx:1140`) although the embed chat has no sidebar. The
  composer, its glass card, the context shelf and split-view panes keep their
  own styling, and every rule is scoped away from the full dashboard's
  `data-testid="app-frame"` shell. The smoke measures all four edges at 0 px.
- Folders. The tab follows the window's first folder; a folder change reloads
  the frame on that folder's slot. Session tabs, "+" and the all-tabs menu are
  the embed route's own (`EmbedTabStrip`).
- Not Kiro Crew desktop. The frame gets no Electron preload, so desktop-only
  extras (the native browser panel, desktop popouts) fall back to their browser
  behaviour, and VS Code keybindings do not reach the frame while it has focus.
  Its `localStorage` (embed tabs, panel widths) is its own, separate from the
  main dashboard's.

### Secret storage (GitHub sign-in survives reloads)

Before 0.5.0, signing in to GitHub in VS Code worked but was lost when the
Kiro Crew window was refreshed, while installed extensions stayed.

- Cause. The web workbench keeps extension secrets (the GitHub sign-in is one,
  stored by the built-in GitHub authentication extension through
  `context.secrets`) in an encrypted `localStorage` entry only when the page has
  a readable `vscode-secret-key-path` cookie naming a key-minting endpoint
  (`vscode/src/vs/code/browser/workbench/workbench.ts:618-633`). Without that
  cookie, and with a remote authority (always the case here), it passes no
  `secretStorageProvider`, so `BrowserSecretStorageService` falls back to its
  in-memory base class (`workbench/services/secrets/browser/secretStorageService.ts:24-33`,
  `platform/secrets/common/secrets.ts:227-237`): every secret is gone after a
  reload. Extensions live on the server, so they survived. `code serve-web`
  provides that cookie and endpoint (`cli/src/commands/serve_web.rs:64-71`,
  `:254-289`); the launcher runs the server directly and had neither.
- Fix. The frame proxy implements the same scheme (`backend/lib/secretkey.mjs`).
  Every workbench page sets `vscode-secret-key-path=/_vscode-cli/mint-key` and
  an HttpOnly `vscode-cli-secret-half` (32 random bytes, kept when the browser
  already has one). `POST /_vscode-cli/mint-key` on the frame port answers
  `sha256(server half || client half)`, 32 bytes, as serve-web does. The
  workbench then encrypts each secret with AES-GCM under that key XOR a
  per-value random key (`ServerKeyedAESCrypto`) into `localStorage`
  `secrets.provider`.
- The server half is 32 random bytes in `data/state/secret-key-half`, created
  on first start, written with mode 0600 and, on Windows, an ACL with
  inheritance removed and only the current user granted (`icacls`). It is never
  logged, never put on a command line or in an environment variable, so no
  terminal or child process sees it.
- Cookies in the cross-site frame. serve-web uses `SameSite=Strict`, which a
  browser neither stores nor sends in a frame whose top page is another site
  (the dashboard on `localhost`, the frame on `127.0.0.1`). The proxy sends
  `SameSite=None; Secure; Partitioned; Path=/`. Chromium accepts `Secure` on
  `http://127.0.0.1` (a potentially trustworthy origin), and `Partitioned`
  (CHIPS) keys the cookies to the dashboard's site, so they work even with
  third-party cookies blocked and no other site's page can send them. The
  client half lives 400 days (Chromium's cap; serve-web uses 30) and is re-set
  with every workbench page.
- The mint path is outside the `/vsc-<key>` prefix because the path cookie is
  kept on disk by the browser, and the prefix must never be written to disk.
  The endpoint takes only POST, a loopback Host, no `Origin` or the frame's own,
  and a well-formed client half; anything else gets 403 or 405. Without the
  HttpOnly half nothing useful can be minted.
- Storage partitioning. Chromium partitions a cross-site frame's
  `localStorage`, IndexedDB and cookies by the top-level site. The top-level
  site here is always the dashboard's (`http://localhost`, the port is not part
  of a site), so the partition is stable across reloads, launcher restarts and
  dashboard port changes, which is why the open editors were already restored
  before 0.5.0. The smoke test reads the cookies' partition key. Opening the
  frame URL in its own tab would use another partition, with its own secrets.
- What an agent on this machine can read. Kiro Crew agents run as the same
  user, so the owner-only ACL does not keep them from `data/state/secret-key-half`.
  The key also needs the client half, which exists only in the browser's
  cookie store (HttpOnly, never sent to anything but the frame port) and the
  ciphertext in the browser's `localStorage`; both live in the Kiro Crew
  desktop app's profile on disk. A same-user process that reads all three can
  decrypt the secrets, as it could with serve-web or VS Code desktop's own
  same-user secret store. The probe route (`POST /api/secret-probe`) reaches
  only one fixed key of the bridge's own secrets.

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
node scripts/render-icon.mjs      # rebuild the icon files from ui/icon.svg, plus .cache/icons/preview.png
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
`chat.png`, `after-restart.png`, `crew-tab-dark.png`).

The Kiro Crew tab checks live in `scripts/lib/tab-checks.mjs`. The dashboard
behind the tunnel there is the mock gateway's (`test/support/dashboard-mock.mjs`,
sign-in links, the link exchange with cookies named after the Host port,
refresh with reuse detection, logout, an `/embed/chat` page with the
composer chips, frame headers like the real ones, and `/api/ws`), not the real
Kiro Crew SPA. The stand-in sets an HttpOnly dashboard session cookie and
serves `/api/auth/mobile-link` only to requests that carry it. The checks
cover: the automatic sign-in when the page opens; the status bar item opening
the tab on the folder's slot (a folder name with a space), signed in, with the
WebSocket open; the tab next to Chat and nothing drawn by the page; the webview
served from `<uuid>.localhost` with no webview from vscode-cdn.net; the chip
hidden in the tab while another app's shows; no `mc_*` cookie in the browser
and the session file owner-only and never logged; credential routes refused
from inside the tab, a bare `Host` 421 and a foreign `Origin` 403;
Ctrl+Alt+K; Disconnect (logout at the gateway, origin rotated, old origin
refused); Connect in the tab; a refused mint (no dashboard URL) followed by a
pasted link; the Markdown preview from the loopback endpoint; and, after the
launcher restarts with the page open and with a new browser, the tab still
signed in with no new link.

The secret storage checks live in `scripts/lib/secret-checks.mjs`: the cookie
attributes on the workbench page, the browser keeping both cookies partitioned
to the dashboard's site with only the path cookie readable in the frame, the
mint endpoint (stable per client half, refusing a missing half, a foreign
Origin and GET), the server half's file, ACL and absence from logs and
settings, and a value stored through the bridge's `context.secrets` that is
encrypted in the frame's `localStorage` and reads back after a page reload, a
launcher restart with the page open, and a launcher plus browser restart on the
same profile.

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
row, the nav card `mx-2 mt-0 mb-2` in a 74px track as the collapsed icon rail
or a 236px track as the expanded sidebar with its header hairline, an
unpadded, scrolling `<main id="main-content">`),
a Dracula-style dark palette and a light one with the dashboard's token names,
a chat view whose composer shelf mounts the app's session control, and a router
that unmounts the page when you leave it. With it the smoke test checks the
card's radius and border, that it sits 8px from the nav card with its top and
bottom level with it and 8px in on the right, in both nav modes; that the
toolbar's centre is on the 23px header line and its bottom border on the
expanded sidebar's hairline; that the frame meets the toolbar and the card's
inner edges with no gap or overlap and is clipped to the 15px inner radius;
that the installed bridge extension carries its icons and VS Code's
Extensions view shows its Kiro Crew icon; that a first plain chat
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

`ui/icon.svg` is the real Visual Studio Code icon, copied from an installed
VS Code (`resources/app/out/media/code-icon.svg`), not the Code-OSS art. The
icon is a Microsoft trademark. Using it here is fine only for John's personal
use on his own machine; swap it for original art before any public release of
this app.

`node scripts/render-icon.mjs` builds every other icon file from it. The
flat marks keep the real outline with two flat fills: the body takes
`--ico-a` and the right-hand panel takes `--ico-b`, written as
`fill="var(--ico-a, ...)"` like Kiro Crew's built-in icons. The fallback
colours are neutral greys meant to read as nav text on any theme: a muted
grey on the idle row, and near-white (dark mode) or near-black (light mode)
on the selected row. No blue, and nothing tied to one theme.

| File | Manifest field | Shown |
| --- | --- | --- |
| `assets/icon-flat.svg` | `iconPath` | the rail's selected row, the store tile and the detail page |
| `ui/icon-idle.svg` | `ui.pages[0].iconInactiveUrl` | the rail row when it is not selected |
| `ui/icon-mono.svg` | `ui.pages[0].iconUrl` | same file as `icon-flat.svg`; the rail reads it only when an app has no `iconPath` |

Kiro Crew draws an installed app's rail icon as a plain `<img>`, in 0.13.0-rc.1
and in the 0.14 source alike (`shell/appShell.tsx:731-745`): only first-party
`/app-assets/<a>/<b>.svg` files are inlined so theme variables reach them
(`components/AppIcon.tsx:51`), and an installed app cannot place files there.
So each file picks its colours itself, with `@media (prefers-color-scheme:
dark)`. Chromium answers that query inside an `<img>` from the page's
`color-scheme`, which Kiro Crew sets per mode, so the icon switches with dark
and light mode. It cannot take a theme's exact text or accent colour; a
lucide glyph can, because it paints in `currentColor`. The only glyph the rail
gives an installed app is `Package`, and only when the app declares no icon
at all (`appShell.tsx:732-739`; `glyphAllowed` is false for installed apps,
`appNav.ts:227`), so the flat VS Code mark is the closer match.

Inside VS Code the bridge extension uses Kiro Crew's own mark.
`extension/kiro-crew-bridge/icon.png` is Kiro Crew's app icon, copied
unchanged from `website/public/icon-512.png` in the Kiro Crew source (the same
bytes the installed dashboard serves as `/icon-512.png`). It is the
extension's `icon` in the Extensions view and the avatar of the Kiro Crew chat
participant and sessions. `extension/kiro-crew-bridge/media/kiro-crew.svg`,
the Kiro Crew view container icon, is the two-ghost crew glyph from Kiro
Crew's `website/src/assets/crew-member-mark.svg`, drawn in `currentColor` so
VS Code tints it like its own icons. These are Kiro Crew's marks. The Kiro
Crew source is Apache-2.0, which grants no trademark rights (section 6), so
check their use before any public release of this app.

The composer chip uses the `Tag` glyph (0.5.3): it accepts only a name from
`AppIcon`'s eleven lucide icons, matched case-sensitively with `Package` as the
fallback (checked in the installed 0.13.0-rc.1 bundle, `AppIcon-*.js`, which has
no alias or case-insensitive lookup), and none of them depicts code. `Tag` is
the closest, as the angle-bracket tag of markup. A real code glyph needs a Kiro
Crew change (`Code` is already in the panel-tab icon set, and `iconUrl` on
session controls is written up in `research/R7-icon-paths.md`). The tunnel's
chip-hiding CSS matches the chip by its label and this glyph. The Kiro Crew
change that would let both surfaces use the theme's own colours is written up in
`research/kirocrew-icon-proposal.md`.

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
- Extension secrets (GitHub sign-in) persist in the browser profile under a
  key split between `data/state/secret-key-half` and an HttpOnly cookie (see
  "Secret storage"). Clearing the Kiro Crew desktop app's site data, or a
  replaced or deleted key file, loses them; VS Code then drops the unreadable
  entry and you sign in again.
- The Kiro Crew tab relies on the workbench's `webviewEndpoint` option and
  on the webview host page accepting a `<uuid>.localhost` origin; both are
  public behaviour of the 1.146 web build but not a documented contract.
- The tunnel was proven against a mock gateway and a mock dashboard page. The
  real SPA through the tunnel, the real mobile-link mint and an authenticated
  WebSocket on the live 0.13.0-rc.1 are still to be checked (see "Next steps").
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
- The tab's chat cannot be pre-filled with VS Code's selection or active
  file: the embed route takes no draft. That needs a Kiro Crew addition.
- Edit tool rows from Kiro Crew carry no absolute path, so the native
  session's tool cards cannot open or diff the edited file in VS Code yet.
  A follow-up has to resolve them against the slot's project.
- The approval card uses VS Code's internal confirmation tool, which the
  workbench registers late (the Eventually lifecycle phase). An approval that
  arrives before then is retried for a while and then falls back to a quick
  pick.
- The session type, its pickers and the approval card depend on the 1.146
  proposed APIs listed above. Proposals change between VS Code releases, so a
  newer server build may need code changes.
- VS Code's secondary side bar starts about 300px wide; drag its sash to widen
  it, and VS Code remembers the width.

## Next steps

1. Install into the live Kiro Crew 0.13.0-rc.1 desktop app from the staged
   copy and check, live:
   - With no dashboard URL the page shows the setup note. Run its command
     (`kirocrew config set dashboard.url http://localhost:5476`, or whatever
     origin the note shows), restart Kiro Crew, and the tab should then sign
     in by itself with no paste. Check whether `kirocrew` runs on this Windows
     install; if it does not, add `"url": "http://localhost:5476"` under
     `dashboard` in `~/.kiro/crew/config.json` by hand, or paste a
     `kirocrew token` link.
   - Security Posture may report the session pin as shared (the tunnel's
     requests are proxied); that is expected.
   - The tab shows the real chat for the folder's "VS Code: <folder>" session,
     a turn streams, an approval can be answered there, and the session tabs,
     pickers and side panels work in a side-bar-wide view.
   - The WebSocket stays open (the launcher log shows `kc WebSocket /api/ws 101`)
     and no `mc_*` cookie appears in the tab's frame.
   - From the frame's DevTools console, `fetch('/api/token/local',{method:'POST'})`
     is refused by the tunnel and a config save is refused by the gateway.
   - The tab stays signed in across a launcher restart, a gateway restart and
     an hour or more (a refresh cycle), and Disconnect then reload shows the
     sign-in panel.
   - Claude Code's tab, the Markdown preview and Simple Browser still work with
     webviews served from loopback.
   - The page height, focus, keyboard and clipboard inside the real dashboard.
2. Follow the active Kiro Crew chat's project folder, and add a chat side-panel
   tab (`contributes.panelTabs`) that shows VS Code's active file.
3. Navigate to the app page automatically after "Open in VS Code" if Kiro Crew
   adds a navigate action to `fileMenuItems` results.
4. Try the `window.browserAPI` native view if iframe focus or clipboard
   behaviour is not good enough in the desktop app.
