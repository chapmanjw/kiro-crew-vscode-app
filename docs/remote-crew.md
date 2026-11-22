# Using the app on a Remote Crew

On a Remote Crew (a dashboard reached through the hub's tunnel) the browser
cannot reach `127.0.0.1:<frame port>` on the launcher's machine, so two things
change. Local installs are unaffected.

The workbench loads from the app's web origin. `app.json` sets
`backend.webOrigin: true`, so the gateway relays
`http://vscode-pane.apps.localhost:<dashboard port>`, HTTP and WebSocket, to
the launcher's own port. The browser resolves `*.localhost` to its own
loopback, so the request rides whatever carries the dashboard. The page decides
per launcher run: it loads `/_vscp-probe` from the frame port in a hidden
iframe, and if that document does not report this run's id within 2.5 s it
loads `http://vscode-pane.apps.localhost:<its own port>/vsc-<key>/...` instead.
On that host the launcher serves the workbench under the unguessable key path
and the key mint route; the signed and bridge API are not served, the
workbench's origin and WebSocket `Origin` must be that same host, and the
gateway forwards no credential of its own.

The "Kiro Crew" tab shows the same chat as locally. A webview cannot frame the
chat from there (the gateway's relay rewrites `frame-ancestors` to the dashboard
and itself, which excludes a webview's origin), so the launcher adds
`/vsc-<key>/_vscp-kc.js` to the workbench page it serves
(`backend/lib/overlay.mjs`). The script finds the tab's webview iframe (VS Code
names it `...pre/index.html?id=...&extensionId=kiro-crew.kiro-crew-bridge&purpose=webviewView`),
lays an iframe over its rectangle in the workbench's own document, and follows
it as the side bar resizes or the tab is hidden. The iframe shows what the page
tab shows: the script reads the window's `?vscpTab=<id>` (or, without it, asks
the page in its parent), and `GET /vsc-<key>/_vscp-kc/state?tab=<id>` answers
with the embed path, `/embed/chat/<key>?sid=<key>` for a chat's tab or
`/embed/sessions`; it creates nothing. That frame is the dashboard's page on the same origin, served by
the launcher's Kiro Crew proxy (`backend/lib/kcproxy.mjs`, which attaches the
dashboard session, refuses the credential routes and checks `Origin`). Its
frame chain is the workbench (same origin) and the dashboard, which the relay
allows. The tab's own webview stays an empty placeholder (it still shows the
sign-in panel when the tab is not connected). Every path outside the workbench's
key path is the chat, and is served only to a browser that holds the
`vscp-viewer` cookie, set HttpOnly (and partitioned) on the workbench page, so a
local process or another page that reaches the same tunnel port gets 404.

The relay serves only the gateway's own dashboard ports, and a tunnel's local
port is not one of them, so before it loads the workbench the page asks the
launcher, which runs beside the gateway, `GET /api/web-origin?port=<the port
this browser reaches the dashboard on>`. The launcher asks the gateway what the
browser will ask it (`Host: <app>.apps.localhost:<port>` for the launcher's
probe path, `backend/lib/weborigin.mjs`) and reports `ok`, `port_not_allowed`
(421 on that port but not on the gateway's own), `refused` (421 on both),
`not_enabled` (the gateway has no web origin for the app) or
`gateway_unreachable`, with the ports already listed in
`<Kiro Crew home>/.env`. For `port_not_allowed` the pane shows the reason and an
**Allow port N** button, which calls `POST /api/web-origin/allow-port` and adds
the port to `KIROCREW_ALLOWED_LOOPBACK_PORTS` in that `.env` (owner-only, every
other line kept, existing ports kept). The gateway reads the variable at start,
so the pane then says to restart Kiro Crew on that machine and offers a copy
button for the command and **Check again**; if the port is already listed it
goes straight to the restart. When the file cannot be written the pane prints
the exact line to add. The port is the one this browser actually uses, so a
changed tunnel port is detected the next time the pane opens.

What this trades away: the workbench and the signed-in chat share one origin on
a remote crew, so code running in the workbench page can call the chat's API as
the signed-in owner (locally they are separate origins). VS Code's server and
extensions already run as you on that host. Other limits of the route: the relay
serves only the dashboard's own ports and only direct loopback requests, so a
tunnel whose local port the gateway does not count as a dashboard port
(`KIROCREW_ALLOWED_LOOPBACK_PORTS` on the remote), or one carried by the Session
Manager listener, is refused with 421 (the reason is in the security log,
`security_events.jsonl`); the relay allows one origin per app, so VS Code's
per-webview `<uuid>.localhost` hosts are not used and webviews take VS Code's
default endpoint; and the overlay relies on VS Code's webview iframe naming, so
a VS Code release that changes it needs the finder in `overlay.mjs` updated.
