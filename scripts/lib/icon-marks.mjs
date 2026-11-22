// Flat, theme-following versions of the VS Code mark, built from the real
// geometry in ui/icon.svg: the silhouette is the icon's own alpha mask path,
// the right-hand panel is its top-layer panel path. No gradients, filters or
// blends; two flat fills.
//
// The fills are written the way Kiro Crew's built-in icons are
// (fill="var(--ico-a, ...)" / fill="var(--ico-b, ...)"), so a host that inlines
// the file paints it from the theme tokens. Kiro Crew shows an installed app's
// icon as <img>, where no host CSS reaches the file, so today the literal
// fallbacks render. They are neutral greys tuned to read as nav-rail text on
// any theme, not any one theme's colours: a muted grey for the idle row and a
// near-white / near-black for the selected row, picked by
// prefers-color-scheme. In Chromium an SVG shown through <img> answers that
// query from the EMBEDDING document's color-scheme (measured: the root's
// `color-scheme` wins over the emulated OS preference), and Kiro Crew sets
// color-scheme per mode (website/src/styles/design-tokens.css,
// website/src/hooks/themeCss.ts), so the files follow its dark/light mode in
// Electron and in a browser alike.

/** Neutral fallbacks. a = silhouette (--ico-a), b = right-hand panel (--ico-b). */
export const NEUTRAL = {
  idle: { light: { a: '#6E6C78', b: '#4E4C57' }, dark: { a: '#8F8DA0', b: '#B4B2C4' } },
  lit: { light: { a: '#3F3E47', b: '#18181B' }, dark: { a: '#D9D7E3', b: '#FFFFFF' } },
};

// Same padding as the 464-of-512 store PNG, so the idle and lit files are the
// same size when the rail swaps between them.
const PAD = 13.3;
const VIEWBOX = `${-PAD} ${-PAD} ${256 + 2 * PAD} ${256 + 2 * PAD}`;

/** Pull the two paths out of the full-colour icon. Throws if its shape changed. */
export function extractPaths(svg) {
  const mask = svg.match(/<mask\b[^>]*>\s*<path\b[^>]*\sd="([^"]+)"/);
  const panel = svg.match(/<g filter="url\(#filter1_d\)">\s*<path d="([^"]+)"/);
  if (!mask || !panel) throw new Error('ui/icon.svg no longer has the expected mask and panel paths');
  return { silhouette: mask[1], panel: panel[1] };
}

function mark({ silhouette, panel }, { light, dark }) {
  // The <style> block is for the <img> path: the light pair is the default and
  // the dark pair overrides it under prefers-color-scheme: dark. A host that
  // inlines the file with <style> stripped still has the fill attributes.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="${VIEWBOX}">`
    + `<style>.a{fill:var(--ico-a,${light.a})}.b{fill:var(--ico-b,${light.b})}`
    + `@media (prefers-color-scheme:dark){.a{fill:var(--ico-a,${dark.a})}.b{fill:var(--ico-b,${dark.b})}}</style>`
    + `<defs><clipPath id="vsc-shape"><path clip-rule="evenodd" d="${silhouette}"/></clipPath></defs>`
    + `<path class="a" fill="var(--ico-a,${light.a})" fill-rule="evenodd" d="${silhouette}"/>`
    + `<path class="b" fill="var(--ico-b,${light.b})" clip-path="url(#vsc-shape)" d="${panel}"/>`
    + `</svg>\n`;
}

/** The blue VS Code mark: the icon's own three fills, flat, on a transparent ground. */
export const BLUE = { upper: '#0065A9', lower: '#007ACC', panel: '#1F9CF0' };

function blueMark(sourceSvg, { silhouette }) {
  const fillPath = (hex) => {
    const m = sourceSvg.match(new RegExp(`<path d="([^"]+)" fill="${hex}"`, 'i'));
    if (!m) throw new Error(`ui/icon.svg no longer has the ${hex} path`);
    return m[1];
  };
  // No <style> and no media query: the same blue shows on a light or a dark page.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="${VIEWBOX}">`
    + `<defs><clipPath id="vsc-shape"><path clip-rule="evenodd" d="${silhouette}"/></clipPath></defs>`
    + `<g clip-path="url(#vsc-shape)">`
    + `<path fill="${BLUE.upper}" d="${fillPath(BLUE.upper)}"/>`
    + `<path fill="${BLUE.lower}" d="${fillPath(BLUE.lower)}"/>`
    + `<path fill="${BLUE.panel}" d="${fillPath(BLUE.panel)}"/>`
    + `</g></svg>\n`;
}

export function buildMarks(sourceSvg) {
  const paths = extractPaths(sourceSvg);
  return { idle: mark(paths, NEUTRAL.idle), lit: mark(paths, NEUTRAL.lit), blue: blueMark(sourceSvg, paths) };
}
