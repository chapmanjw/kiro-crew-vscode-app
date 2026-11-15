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

export function chipHideCss(icon = CHIP_ICON) {
  const cls = `lucide-${String(icon).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
  if (!/^lucide-[a-z0-9-]+$/.test(cls)) throw new Error('bad icon name');
  const chip = `button[data-session-control-chip]:has(svg.${cls})`;
  const other = `button[data-session-control-chip]:not(:has(svg.${cls}))`;
  // The chip, and the chip row's wrapper when ours was its only chip.
  return `${chip}{display:none !important}\ndiv:has(> ${chip}):not(:has(> ${other})){display:none !important}`;
}
