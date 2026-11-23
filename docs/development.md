# Development, tests and icons

## Development and tests

```
node --test "test/*.test.mjs"     # unit tests (node:test)
node scripts/smoke.mjs            # end-to-end against the cached server build
VSCODE_PANE_SERVER_DIR=<build> SMOKE_BROWSER=<chrome> node scripts/overlay-smoke.mjs   # the Kiro Crew tab on the web origin, in a real browser (Node 22+, no packages)
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
connects. `/api/open` opens a file at a line, the state readout in the menu
follows, the window says which page tab it is from its configuration, and the
file-menu route works. A killed server is restarted
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
the bridge and from the painted status bar, picks another theme in VS Code's
own picker and checks it shows without the Kiro Crew palette, survives a
reload and a change of the Kiro Crew theme (the palette moving to the other
stock theme), and that picking the stock theme the palette is scoped to brings
the palette back (`scripts/lib/theme-checks.mjs`), reloads the page and checks the
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

The viewer-reach checks live in `scripts/lib/reach-checks.mjs`. They open the
stand-in at a name that is not a loopback name (`tunnel-viewer.test`, which the
smoke's browser resolves to 127.0.0.1 with `--host-resolver-rules`) and check
that, with the frame port unreachable, the pane shows "VS Code cannot load at
this address" with the port forward for the gateway's port and creates no VS Code
frame, that Check again probes again, and that a frame port that does answer is
used at that same address.

The Kiro Crew tab checks live in `scripts/lib/tab-checks.mjs`. The dashboard
behind the tunnel there is the mock gateway's (`test/support/dashboard-mock.mjs`,
sign-in links, the link exchange with cookies named after the Host port,
refresh with reuse detection, logout, an `/embed/chat` page with the
composer chips, frame headers like the real ones, and `/api/ws`), not the real
Kiro Crew SPA. The stand-in sets an HttpOnly dashboard session cookie and
serves `/api/auth/mobile-link` only to requests that carry it. The checks
cover: the automatic sign-in when the page opens; the status bar item opening
the tab on the session list (`/embed/sessions`, for VS Code opened on a folder
whose name has a space), signed in, with the WebSocket open, and no session
created; the tab next to Chat and nothing drawn by the page; the webview
served from `<uuid>.localhost` with no webview from vscode-cdn.net; the chip
hidden in the tab while another app's shows; no `mc_*` cookie in the browser
and the session file owner-only and never logged; credential routes refused
from inside the tab, a bare `Host` 421 and a foreign `Origin` 403;
Ctrl+Alt+K; Disconnect (logout at the gateway, origin rotated, old origin
refused); Connect in the tab; a refused mint (no dashboard URL) followed by a
pasted link; the Markdown preview from the loopback endpoint, painted in the
editor's background and not on a white canvas; and, after the
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
that the composer chip lands on `/apps/vscode-pane?folder=<chat project>&session=<chat>`,
opens a new tab in front whose window loads that folder with its tab id and
whose Kiro Crew view frames that chat with no session created, that clicking
the first tab shows its window again with both windows loaded and nothing
reloaded, that the chip again brings back the chat's tab instead of opening
another, that New tab opens a typed folder as a tab of its own and lists the
recent projects, that a folder with a `.code-workspace` file opens as that
workspace (the window reports the file, the explorer shows the workspace's
folders and the tab stays on the folder), and that a tab's close button removes
the tab and its window.
`.cache/smoke/pane-dark.png` is the pane in the dark palette and
`.cache/smoke/menu.png` the menu open. The pane then goes back to the workspace
folder's tab for the restart checks.

## Icon

`ui/icon.svg` is the Visual Studio Code icon, copied from an installed
VS Code (`resources/app/out/media/code-icon.svg`), not the Code-OSS art. The
icon is a Microsoft trademark; see the notice in the README.

`node scripts/render-icon.mjs` builds every other icon file from it. The
grey marks keep the real outline with two flat fills: the body takes
`--ico-a` and the right-hand panel takes `--ico-b`, written as
`fill="var(--ico-a, ...)"` like Kiro Crew's built-in icons. The fallback
colours are neutral greys meant to read as nav text on any theme: a muted
grey on the idle row, and near-white (dark mode) or near-black (light mode)
on the selected row. These two grey files have no blue and nothing tied to one theme. `assets/icon-blue.svg` is the exception: it keeps the VS Code blues (#0065A9, #007ACC, #1F9CF0) on every theme, and reads on white and on Kiro Crew's dark background.

| File | Manifest field | Shown |
| --- | --- | --- |
| `assets/icon-blue.svg` | `iconPath` | the blue VS Code mark, transparent with no colour-scheme rule: the store tile, the detail page and the rail's hover and selected rows |
| `ui/icon-idle.svg` | `ui.pages[0].iconInactiveUrl` | the rail row when it is not selected |
| `ui/icon-mono.svg` | `ui.pages[0].iconUrl` | the grey mark (the selected pair); the rail reads it only when an app has no `iconPath` |

Kiro Crew draws an installed app's rail icon as a plain `<img>`, in Kiro Crew 0.13.0
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
`appNav.ts:227`), so the VS Code mark is the closer match.

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
check their use before redistributing them.

The composer chip uses the `Package` glyph (0.5.6; `Tag` in 0.5.3 to 0.5.5): it
accepts only a name from `AppIcon`'s eleven lucide icons (`Shield`, `Bot`,
`Search`, `Tag`, `Users`, `Zap`, `Star`, `Package`, `Cat`, `AudioLines`,
`Mic`), matched case-sensitively with `Package` as the fallback (read from the
Kiro Crew 0.13.0 dashboard bundle, which has no alias or case-insensitive
lookup), and none of them depicts code. A real code glyph needs a Kiro
Crew change (`Code` is already in the panel-tab icon set). The tunnel's
chip-hiding CSS matches the chip by its label and this glyph.

`node scripts/render-store-art.mjs` builds the App Store artwork: `assets/store-hero.svg`
(`heroImage`, 16:9), `assets/store-hero-detail.svg` (`heroImageDetail`, 25:6) (the hero images show a Visual Studio Code window holding the VS Code mark and the Kiro Crew app icon
(`assets/kirocrew-logo.svg`, copied unchanged from `site/public/kirocrew-logo.svg` in the Kiro Crew source).
Kiro Crew also draws the rail's hover and selected rows from `iconPath`, so hover and selected rows show the blue VS Code mark; idle rows use
`ui.pages[0].iconInactiveUrl` (the grey mark, unchanged). `node scripts/render-store-previews.mjs` renders the tile and both
banners the way Kiro Crew crops them into `research/P7-previews/`.
