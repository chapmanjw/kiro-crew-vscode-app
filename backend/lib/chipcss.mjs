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
