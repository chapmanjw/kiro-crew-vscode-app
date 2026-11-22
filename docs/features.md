# Features in detail

Tabs, VS Code Chat answered by Kiro Crew, theming, the page in the dashboard, the Kiro Crew tab in VS Code, secret storage and the file menu entry.

## Tabs (0.6.4)

The page holds VS Code in tabs, each one VS Code window on a folder, all
served by the one VS Code server and its one connection token. The launcher
keeps the list in `data/state/tabs.json` (`backend/lib/tabs.mjs`, at most 20),
so tabs survive page reloads and launcher restarts; the page only shows them.

- A tab opened from a chat's VS Code chip (`?folder=<cwd>&session=<key>`) is
  that chat's tab. Its Kiro Crew view frames the chat itself
  (`/embed/chat/<key>?sid=<key>`, the way the dashboard's own embed tabs open
  one), and the chip brings the same tab back instead of opening another,
  wherever its folder is now. A chat with no project folder gets a tab on the
  default folder. The tab keeps the chat's slot name, which is the dashboard's key
  without its `dashboard:` prefix, because the embed names chats that way.
- Any other tab (New tab, a `?folder=` link, a folder from the file menus,
  the first tab of a first run) shows the dashboard's session list with its
  New button (`/embed/sessions`). Opening VS Code never creates a Kiro Crew
  session; one is made only from that list, by the user. (Up to 0.5.6 the view
  created a session per folder when it opened.)
- Only tabs looked at since the page loaded have a window. The others load
  when first shown, and switching tabs reloads nothing: hidden windows stay
  loaded behind the front one. After a server restart, a hidden window reloads
  when it is next shown.
- A folder that holds a `*.code-workspace` file opens that workspace in place of
  the folder (0.6.4): the window loads `?workspace=<file>` rather than
  `?folder=<folder>` (`backend/lib/workspacefile.mjs`). With several files, the
  one named after the folder (`my-app/my-app.code-workspace`) opens, else the
  first by name; only files directly in the folder count. The tab itself stays
  on the folder, so its label, its chat and the file menus' "Open in VS Code"
  still go by the folder, and a window on that file does not move its tab even
  when the workspace lists other folders first. The folder is read when the
  page builds a window's URL, so a workspace file added later is used from that
  tab's next load (Reload, a server restart) and the open window is left alone.
  A window that opens another workspace file itself (File > Open Workspace from
  File) takes its tab to that file's folder.
- Labels are the folder's name, numbered when two would repeat. A chat's tab
  shows the chat's title instead when the host shares session titles with the
  app (the SDK's `useHostSessions`, which needs `/api/config/default-agent` in
  `permissions.api`; the manifest does not ask for it, so today chat tabs show
  their folder name too).

The Kiro Crew view is an embed on the tunnel's origin, and the tunnel adds one
script to each `/embed/` page, served at `/_vscp-kc/embed.js`
(`backend/lib/embedboot.mjs`). The script does two things.

First, it gives each view its own tabs. The embed keeps its open tabs in
`sessionStorage` (`kirocrew-embed-tabs` and `kirocrew-embed-active-index`),
and every embed in one dashboard tab shares that storage, so without help a
view could show another view's chat. The script tells views apart by a random
id in `window.name`, which belongs to the view's frame and survives the frame's
own page loads. It keeps each view's tabs in `sessionStorage` under that id and
answers the embed's reads and writes of the two keys from them. The shared keys
are never written. A new view starts from its URL: the chat named by `?sid=`, or
the session list.

Second, it works around a fault in the embed's tab strip. The strip copies the
store's active chat into the Sessions tab whenever the route changes, so
closing the last chat tab, clicking New tab, or clicking the Sessions tab
turned that tab back into the chat the store still held, or into the first chat
in the list. A page that loads fresh on the list does not do this. So when the
strip moves from a chat page to the list, the script holds that move back, lets
the strip finish saving its tabs, freezes the page, and loads the list page
again. The saved tabs rebuild the strip, so the other tabs stay. In the check, a
draft typed in a chat's message box was still there after closing the chat and
opening it again. The view reloads for a moment when it goes to the list.

The script depends on the names in the dashboard's bundle: the two storage
keys, the `kirocrew-tab-update` event and the two routes. If a Kiro Crew update
renames one of them, that part does nothing and the embed behaves as it does
without the script. Kiro Crew 0.13.0.2 is the version this was checked against.
Version 0.6.2 cleared the store's active chat instead; that made the page pick a
different chat on its own and is gone.

Which window is which tab. The page loads each tab with `?vscpTab=<id>`; the
frame proxy puts `configurationDefaults: {"kiroCrew.paneTab": "<id>"}` into
that page's workbench configuration (the embedder option the browser
workbench registers as default settings, which the extension host receives),
and the bridge reads the setting's default, never a user value, and says it in
every `hello`. A window that lost it (VS Code's own Open Folder navigates the
frame to a URL of its own) asks the page from its Kiro Crew view: a
`postMessage` up the frame chain, which the page answers only for a window
inside one of its own frames, and only with the tab id. The tab then follows
the window to its new folder. Remote viewers' chat overlay reads the same
query value (see "On a Remote Crew").

Every window long-polls for its own commands (`lib/bridge.mjs`): a command for
a tab goes to the tab's newest window by when its extension host started, so a
reloaded window's old host, which runs on until the server's reconnection grace
ends, gets nothing; the theme and tunnel changes go to every window. Files from
`/api/open` and the file menus go to the tab whose folder holds them (the
deepest), and that tab comes to the front.

The toolbar has the tabs, New tab (a folder field and the recent projects)
and one menu button whose dot is the server's status (an accent badge when an
update is out). The menu holds what used to be toolbar buttons: Reload this
tab, Restart the VS Code server, Check for updates and Update to <version>
(for a build the app installed), the Kiro Crew tab's sign-in state with Connect
or Disconnect, Show the Kiro Crew tab in VS Code, and the active file. The
open-file form is gone; Kiro Crew opens files through the file menus and
`/api/open`.

The frame port also serves `POST /_vscode-cli/mint-key` (see "Secret storage"
below).

## Kiro Crew as a native VS Code chat session type (0.4.0)

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
- Default tab. `kiroCrew.openByDefault` (default on, an application setting)
  makes the extension open the Kiro Crew tab in the secondary side bar about
  1.5 s after it starts, ahead of Chat. Turn it off to keep VS Code's own
  choice of the last active tab. `KIROCREW_VSCODE_OPEN_BY_DEFAULT=0` in the
  launcher's environment turns it off too (the smoke test sets it).
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

## VS Code Chat answered by Kiro Crew

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

## Theme

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
`ui/vscode-pane-core-<version>.mjs`, including `--diff-*`, `--ring` and
`--search-highlight`). One unknown name drops the whole palette to tier "base",
so `test/contract.test.mjs` fails if the page's list grows a name the launcher
does not know.

In tier "palette" the launcher maps the colours to about 180
`workbench.colorCustomizations` entries covering the editor, side bar, activity
bar, title bar, status bar, panel, tabs, lists, inputs, buttons, focus borders,
chat and the terminal, deriving missing shades from the background, text and
accent. In tier "base" the palette is empty, and both the server's Machine
settings and the user settings lose any earlier palette, so no stale colours
linger.

The palette is written scoped to the stock theme it was made for:
`"workbench.colorCustomizations": {"[Dark Modern]": {...}}`, or `[Light Modern]`
for a light theme. VS Code applies a scoped palette only while that theme is the
colour theme, so it never colours a theme you picked. A tier "base" theme keeps
the key with an empty palette, because the key is also the record of which stock
theme Kiro Crew chose last.

The launcher keeps the result in `data/state/theme.json` and seeds the base
theme and the scoped palette into the server's Machine settings, so the first
paint is already themed. The extension writes the user settings with
`ConfigurationTarget.Global` only when a value differs. Every new extension
host (a start, reload or remount) gets the theme once and reports back what VS
Code holds. `GET /api/session` carries
`theme: {kind, tier}` and `GET /api/theme` adds the reason and what the
extension last did, with `userTheme: true` when it left a theme you picked.
The rules for which theme is whose are in `extension/kiro-crew-bridge/theme.js`,
which the extension and the launcher share.

### A theme you pick (0.6.4)

Kiro Crew sets the colour theme when none is set and keeps it in step with the
dashboard (dark or light) while it is still the one Kiro Crew set. A theme you
pick in VS Code (Ctrl+K Ctrl+T, "Preferences: Color Theme") is yours. Nothing
replaces it when a window loads, on a reload, a new tab, a server restart or a
launcher restart, or when the dashboard changes its theme. Before 0.6.4 every
load wrote Kiro Crew's theme back over the pick.

- VS Code writes the pick into the server's Machine settings, where Kiro Crew's
  own theme sits, so the launcher's seed and the extension both read the
  setting before they write it. The colour theme is Kiro Crew's while it is
  unset or is the stock theme the palette's scope key names (Dark Modern under
  `[Dark Modern]`). Any other name is a pick, the other stock theme included.
- Behind a pick the palette still follows the dashboard: it moves to the stock
  theme of the dashboard's current mode and colours nothing else, so your theme
  looks as its author made it. A flat palette would have laid Kiro Crew's colours
  over it. Picking the stock theme the palette is scoped to brings the Kiro Crew
  colours back at once.
- To hand the theme back, pick that stock theme (Dark Modern for a dark
  dashboard, Light Modern for a light one) or reset `workbench.colorTheme`; the
  next theme change or load sets it again.
- A settings file from 0.6.3 or earlier holds a flat palette with no scope. The
  first start of 0.6.4 replaces it with the scoped one. A stock theme in that
  file counts as Kiro Crew's, and any other theme counts as your pick.

## Browser-side state across remounts and restarts

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

## The page in the dashboard

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
  (`hooks/useRailWidth.ts:20-21`), the same in the 0.13.0 bundle.
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
  hairline. The earlier 34px strip put the border 11px above it. Since 0.6.0
  it holds the tabs, New tab and the menu (see "Tabs"); the menu and the New
  tab panel are drawn on `document.body` (a React portal) above the VS Code
  frames and under the dashboard's own popovers, close on Escape, a click
  elsewhere or a click into VS Code, and move with the arrow keys.
- VS Code keeps running when you leave the page. The dashboard unmounts an app
  page whenever you go to another route, and an iframe taken out of the
  document is destroyed, which is why 0.2.0 started over each time. The
  iframes (one per tab that has been shown) now live in one element on
  `document.body`. While the page is mounted it is placed over the card's body
  and clipped to the card's rounded bottom corners, and only the front tab's
  frame shows in it.
  Placement runs on change, not every animation frame: a `ResizeObserver` on
  the card, its frame slot, `<main>` and the document element (window resize,
  side panels, zoom), window `resize`, capture-phase `scroll`, and a 500 ms
  fallback for a move nothing reports; each trigger asks for at most one
  placement in the next frame. While the page is not mounted the frames are
  hidden, not removed, and lose keyboard focus. A tab's frame is reloaded only
  for Reload this tab, a restarted server or a restarted backend (a new run
  id), and a hidden tab's only when it is next shown.
- Open in Code chip in the chat composer. `contributes.sessionControls` adds a
  "Open in Code" chip to the composer shelf, before the agent chip ("Ultra Mode")
  and the project chip. Kiro Crew mounts the control when the chip is clicked
  and hands it the chat (`session.sessionKey`) and its project folder
  (`session.cwd`); the control navigates to
  `/apps/vscode-pane?folder=<that folder>&session=<the chat>` and the page
  opens the chat's tab, or brings back the one it opened before. A chat with
  no project shows a short note and an "Open VS Code" button, which opens the
  chat's tab on the default folder. The chip's
  glyph comes from the host's fixed set (`Package`, which is also AppIcon's fallback; see below), because session controls
  cannot use an app image: the chip renders `<AppIcon icon={sc.icon} size={13} />`
  with no `iconUrl` (`components/chat-input/ContextShelf.tsx` in 0.14, the same
  call in the shipped 0.13.0 bundle), `AppIcon` maps names to eleven
  lucide icons, the backend's `SessionControlContribution` keeps only `id`,
  `entryPoint`, `label`, `icon` and `statusPath`, and the control's own
  component renders only in the popover, not on the chip. Showing the real
  VS Code mark there needs Kiro Crew to accept an `iconUrl` on session controls
  (kept by the manifest model, resolved under the app's `ui/`) and pass it to
  `AppIcon` in `ContextShelf.tsx`.
- The chip is hidden inside VS Code's Kiro Crew tab, where it would only open
  the VS Code you are already in, and stays on every normal
  Kiro Crew session. No supported way exists: in Kiro Crew 0.13.0 and the 0.14.0
  source a session control has no visibility or `when` field
  (`hooks/useSessionControls.ts` keeps `id`, `entryPoint`, `label`, `icon`,
  `statusPath`), a `statusPath` answer can only set `state` (`ok`, `warn`,
  `none`), `tooltip` and `detail` (`normalizeStatus`), the chip gets neither the
  slot nor the embedding context, and `ChatPanelProps` is `{slotKey,
  conversationOnly, expandSteps}`; `/embed/chat` renders the same composer.
  The fallback is a stylesheet the tunnel adds only to the dashboard HTML it
  serves to the tab (`chipHideCss` in `backend/lib/chipcss.mjs`): it hides
  `button[data-session-control-chip][aria-label="Open in Code"]` whose icon `<svg>`
  has the class `lucide-package`, and the chip row's wrapper when that was its
  only chip. The real dashboard never gets it. The host puts no app identity on
  the chip, so its label (the aria-label is the label alone, since this app
  declares no `statusPath`, `ContextShelf.tsx:117-148`) plus its icon is the
  narrowest stable match; another app's `Package` chip with a different label keeps showing. A Kiro
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
  `ui/vscode-pane-core-<version>.mjs`. When none can be read the body is `{kind}`
  alone, and the backend falls back to stock VS Code Default Dark or Default
  Light. The toolbar degrades the same way: every colour is the dashboard
  variable when set, and otherwise a Default Dark or Default Light colour picked
  by `kind`.

## The Kiro Crew tab in VS Code's right pane (0.5.0)

Kiro Crew's chat is a tab in VS Code's own secondary side bar, next to Chat
(and Claude Code, when it is installed), the way Claude Code adds its tab. The
tab shows Kiro Crew's own dashboard chat, served live by the gateway, so it is
the same code and the same session pane you use in Kiro Crew, with its session
tabs, tool cards, approvals, pickers and side panels. The docked column of
0.4.0 and the overlay tried during 0.5.0 development are both gone.

- The tab. The bridge contributes `viewsContainers.secondarySidebar` `kiroCrew`
  with one webview view, `kiroCrew.chatView` (`extension/kiro-crew-bridge/crewview.js`).
  When the tunnel is signed in, the view is one full-size iframe on the tunnel
  origin (`App.tsx:597-608`, the embed routes built for IDE side panels): for a
  page tab opened from a chat, that chat (`/embed/chat/<key>?sid=<key>`);
  otherwise the session list with its New button (`/embed/sessions`). Its CSP
  allows framing that origin only, and it frames only those two path shapes.
  Clicking the tab, Ctrl+Alt+K, the status bar "Crew" item, the editor title
  action and "Show the Kiro Crew tab in VS Code" in the page's menu open it.
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
  event stream; no narrower token runs it. The gateway itself
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
  action, or the command palette) and "Disconnect the Kiro Crew tab" in the
  page's menu call `POST /api/auth/logout` through the tunnel (that session only), delete
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
  icon `<svg>` has the class `lucide-package`, and the chip row's wrapper when
  that was its only chip. Another app's `Package` chip with a different label keeps showing.
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
- What it shows. The view frames what its page tab shows (see "Tabs"); a
  folder change inside VS Code does not change it, and nothing it loads creates
  a session. Session tabs, "+" and the all-tabs menu at the top of the view are
  the embed route's own (`EmbedTabStrip`). In the session list, the dashboard
  also shows the side panel of the session it last focused (a conductor's
  Board, for example); in a narrow side bar that panel can take most of the
  width until you close it with its panel toggle.
- Not Kiro Crew desktop. The frame gets no Electron preload, so desktop-only
  extras (the native browser panel, desktop popouts) fall back to their browser
  behaviour, and VS Code keybindings do not reach the frame while it has focus.
  Its `localStorage` (embed tabs, panel widths) is its own, separate from the
  main dashboard's.

## Secret storage (GitHub sign-in survives reloads)

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

## Open in VS Code from Kiro Crew file menus

`app.json` declares one `contributes.fileMenuItems` row, "Open in VS Code", on
the file overflow menu, the tree context menu and folder rows. Kiro Crew POSTs
`{item_id, surface, path, kind, root?}` to `/apps/vscode-pane/api/file-menu`. A
file opens in the tab whose folder holds it (the deepest such folder), else in
a tab on the project root the menu names, else in the front tab; that tab comes
to the front. A folder opens as a tab of its own, or brings back the tab
already on it (no tab's folder is replaced any more). The reply carries a toast
message and a link to the app page that names the tab (`?tab=<id>`). The host
does not navigate on its own, so the user clicks the link or the sidebar icon
to see VS Code.
