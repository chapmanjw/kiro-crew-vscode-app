// Hiding this app's own "VS Code" composer chip inside the Kiro Crew tab.
//
// Kiro Crew has no supported way to hide a session control on one surface:
// a control has no visibility or `when` field (website/src/hooks/useSessionControls.ts
// keeps id, entryPoint, label, icon, statusPath), a statusPath answer only sets
// state ok|warn|none, tooltip and detail (normalizeStatus), the chip gets
// neither the slot nor the embedding context, and /embed/chat renders the same
// ChatPage composer (App.tsx:597-608). So the tunnel adds a stylesheet to the
// dashboard HTML it serves, a copy that exists only inside VS Code; the real
// dashboard is untouched. The chip is matched by `data-session-control-chip`
// plus its icon's lucide class, never by text.

/** app.json contributes.sessionControls[0].icon; AppIcon renders it as <svg class="lucide lucide-package"> */
export const CHIP_ICON = 'Package';
/**
 * app.json contributes.sessionControls[0].label. The chip's aria-label is the
 * label alone while the control has no status (ContextShelf.tsx:117-148; this
 * app declares no statusPath). The host renders no app-identity attribute on
 * the chip, so label plus icon is the narrowest stable match: another app's
 * Package-icon chip (Package is AppIcon's fallback) keeps showing (V5 S-6).
 */
export const CHIP_LABEL = 'VS Code';

export function chipHideCss(icon = CHIP_ICON, label = CHIP_LABEL) {
  const cls = `lucide-${String(icon).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
  if (!/^lucide-[a-z0-9-]+$/.test(cls)) throw new Error('bad icon name');
  if (!/^[A-Za-z0-9 ._-]{1,40}$/.test(label)) throw new Error('bad label');
  const chip = `button[data-session-control-chip][aria-label="${label}"]:has(svg.${cls})`;
  const other = `button[data-session-control-chip]:not([aria-label="${label}"]:has(svg.${cls}))`;
  // The chip, and the chip row's wrapper when ours was its only chip.
  return `${chip}{display:none !important}\ndiv:has(> ${chip}):not(:has(> ${other})){display:none !important}`;
}

// Making the tunnelled /embed/chat fill the "Kiro Crew" webview flush.
//
// The embed shell is `<div class="h-screen ... w-screen overflow-hidden bg-bg
// flex flex-col">` holding EmbedTabStrip and a `flex-1 min-h-0` route box
// (App.tsx:680-692; the 0.13.0-rc.1 bundle renders the same div), then
// ChatPageFrame's `flex flex-1 min-h-0 h-full overflow-hidden relative`
// (ChatPageFrame.tsx:74) and the chat pane root `[data-chat-scope]`, which
// gets an inline `margin-left: -8px` (COLLAPSED_PANE_RECLAIM_PX) whenever the
// sessions sidebar is closed on desktop (ChatPage.tsx:112, 1140). In
// /embed/chat the sidebar is 0 px wide (messageActions.ts:252,
// embedChatFrame), so there is nothing to reclaim. `w-screen` is 100vw. These
// rules pin that chain to the viewport with no margin, padding, border,
// radius or shadow; inner parts (the composer's glass pane, the context
// shelf, split-view panes) keep their own styling. Scoped by structure: the
// full dashboard's shell carries data-testid="app-frame" (App.tsx:701) and is
// left alone; the embed shell is the #root child that holds the chat pane.
const EMBED_ROOT = '#root:not(:has([data-testid="app-frame"]))';
const EMBED_HTML = 'html:not(:has([data-testid="app-frame"])):has(#root [data-chat-scope])';
const FLAT = 'margin:0 !important;border:0 !important;border-radius:0 !important;box-shadow:none !important;outline:0 !important';

export function embedFlushCss() {
  const shell = `${EMBED_ROOT} > div:has([data-chat-scope])`;
  // Every box from the shell down to the outermost chat pane (not inside it).
  const chain = `${shell} div:has([data-chat-scope]):not([data-chat-scope]):not([data-chat-scope] *)`;
  const pane = `${shell} [data-chat-scope]:not([data-chat-scope] [data-chat-scope])`;
  return [
    // :has() cannot nest, so the page-level guard repeats the scope flat.
    `${EMBED_HTML},${EMBED_HTML} > body,${EMBED_ROOT}{margin:0 !important;padding:0 !important;border:0 !important;width:100% !important;height:100% !important;overflow:hidden !important}`,
    `${shell}{${FLAT};padding:0 !important;width:100% !important;height:100% !important;max-width:none !important}`,
    `${chain}{${FLAT};padding:0 !important}`,
    `${pane}{${FLAT}}`,
  ].join('\n');
}

/** The whole stylesheet the tunnel injects into the dashboard HTML it serves to VS Code. */
export function tunnelCss() {
  return `${chipHideCss()}\n${embedFlushCss()}`;
}
