# Known limits

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
  frames, and therefore their own workbenches. They share the tab list, and
  picking a tab in one brings it to the front in the other on its next poll.
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
  WebSocket on a live Kiro Crew 0.13.0 have not been checked.
- Each VS Code window takes its own commands (see "Tabs"). A window that
  opened another folder itself has lost its `?vscpTab=`, and until its Kiro
  Crew view has been shown (which asks the page), commands for its tab reach it
  only through the tab's folder. Telling apart two such windows on the same
  folder is not possible, so either may take them.
- The tab id rides in the workbench's `configurationDefaults` and the
  `kiroCrew.paneTab` setting the bridge declares. Both are public behaviour of
  the 1.146 web build (`IWorkbenchConstructionOptions`); a server that set
  `configurationDefaults` of its own would win over the launcher's, and the
  window would then fall back to asking the page.
- The Kiro Crew view's session list is the dashboard's own `/embed/sessions`.
  Its New button starts a session the way the dashboard does; the app does not
  pass the tab's folder to it, so the new session gets the project the
  dashboard picks.
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
