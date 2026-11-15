// Flat, theme-coloured versions of the VS Code mark, built from the real
// geometry in ui/icon.svg: the silhouette is the icon's own alpha mask path,
// the right-hand panel is its top-layer panel path. No gradients, filters or
// blends; two flat fills.
//
// Paint follows Kiro Crew's AppIcon convention (website/src/index.css):
//   idle      --ico-a = --muted   --ico-b = --accent
//   selected  --ico-a = --accent  --ico-b = --text
// The silhouette takes --ico-a and the panel takes --ico-b.

/** Dracula Pro, John's theme (~/Dropbox/Themes/kirocrew-dracula-pro/variables.json). */
export const PALETTE = {
  dark: { name: 'Dracula Pro, dark', panel: '#1A1826', text: '#F8F8F2', muted: '#9C93C9', accent: '#B9A9FF', accentSubtle: '#9580FF26' },
  light: { name: 'Dracula Pro, light', panel: '#F5F5F5', text: '#2A2A2A', muted: '#565289', accent: '#644AC9', accentSubtle: '#644AC91F' },
};

// Same padding as assets/icon.png (464 of 512), so the idle and lit files are
// the same size when the rail swaps between them.
const PAD = 13.3;
const VIEWBOX = `${-PAD} ${-PAD} ${256 + 2 * PAD} ${256 + 2 * PAD}`;

/** Pull the two paths out of the full-colour icon. Throws if its shape changed. */
export function extractPaths(svg) {
  const mask = svg.match(/<mask\b[^>]*>\s*<path\b[^>]*\sd="([^"]+)"/);
  const panel = svg.match(/<g filter="url\(#filter1_d\)">\s*<path d="([^"]+)"/);
  if (!mask || !panel) throw new Error('ui/icon.svg no longer has the expected mask and panel paths');
  return { silhouette: mask[1], panel: panel[1] };
}

function mark({ silhouette, panel }, light, dark) {
  // The fill ATTRIBUTES carry the tokens the way Kiro Crew's built-in icons do
  // (fill="var(--ico-a, ...)"), so a host that inlines the file with <style>
  // stripped still paints it from the theme. The <style> block is for <img>:
  // `light` is the fallback for every renderer; `dark` (optional) overrides it
  // under prefers-color-scheme: dark. In Chromium an SVG shown through <img>
  // answers that query from the EMBEDDING document's color-scheme (measured:
  // the root's `color-scheme` wins over the emulated OS preference), and Kiro
  // Crew sets color-scheme per mode (design-tokens.css, hooks/themeCss.ts), so
  // the file follows the dashboard's dark/light mode in Electron and in a
  // browser alike.
  const media = dark
    ? `@media (prefers-color-scheme:dark){.a{fill:var(--ico-a,${dark.a})}.b{fill:var(--ico-b,${dark.b})}}`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="${VIEWBOX}">`
    + `<style>.a{fill:var(--ico-a,${light.a})}.b{fill:var(--ico-b,${light.b})}${media}</style>`
    + `<defs><clipPath id="vsc-shape"><path clip-rule="evenodd" d="${silhouette}"/></clipPath></defs>`
    + `<path class="a" fill="var(--ico-a,${light.a})" fill-rule="evenodd" d="${silhouette}"/>`
    + `<path class="b" fill="var(--ico-b,${light.b})" clip-path="url(#vsc-shape)" d="${panel}"/>`
    + `</svg>\n`;
}

export function buildMarks(sourceSvg, palette = PALETTE) {
  const paths = extractPaths(sourceSvg);
  const { dark: d, light: l } = palette;
  return {
    idle: mark(paths, { a: l.muted, b: l.accent }, { a: d.muted, b: d.accent }),
    lit: mark(paths, { a: l.accent, b: l.text }, { a: d.accent, b: d.text }),
    // Only ever shown in dark mode (AppIcon resolves iconUrlDark only then), so
    // no media query: in a browser whose OS scheme differs from the dashboard's
    // mode the query would pick the wrong half.
    darkLit: mark(paths, { a: d.accent, b: d.text }),
  };
}
