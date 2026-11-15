// Pure helpers shared by the vscode-pane page and its session control. No React
// and no DOM access at import time, so node:test can load this file directly.
// The file name carries the version for the same cache reason as the page.

export const APP_NAME = 'vscode-pane';
export const APP_ROUTE = '/apps/vscode-pane';
export const API = '/apps/vscode-pane/api';

/**
 * The dashboard theme tokens sent to the backend (POST /api/theme). Names come
 * from Kiro Crew's website/src/styles/design-tokens.css and theme-palettes.css;
 * every built-in palette and theme pack sets them. `--surface` is not a Kiro
 * Crew token today; it is read when a custom theme defines it and skipped
 * otherwise, like any other empty value.
 */
export const THEME_VARS = [
  '--bg', '--bg-accent', '--bg-elevated', '--bg-hover',
  '--card', '--card-fg', '--panel', '--panel-strong', '--surface',
  '--text', '--text-strong', '--muted', '--muted-strong',
  '--border', '--border-strong', '--border-hover',
  '--accent', '--accent-fg', '--accent-hover', '--accent-subtle', '--ring',
  '--ok', '--warn', '--danger', '--info',
  '--diff-add', '--diff-add-text', '--diff-del', '--diff-del-text',
  '--search-highlight',
];

const clamp255 = (n) => Math.max(0, Math.min(255, Math.round(n)));
const hex2 = (n) => clamp255(n).toString(16).padStart(2, '0');

/** RGBA components (0-255, alpha 0-1) to `#rrggbb`. */
export function rgbToHex({ r, g, b }) {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/**
 * Parse the colour strings a browser hands back from getComputedStyle or a
 * canvas: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` (comma or
 * space syntax, % alpha) and `color(srgb r g b / a)`. Returns null for
 * anything else (named colours, oklab, empty).
 */
export function parseColor(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const hx = m[1];
    if (hx.length === 3 || hx.length === 4) {
      const [r, g, b, a] = [...hx].map((c) => parseInt(c + c, 16));
      return { r, g, b, a: hx.length === 4 ? a / 255 : 1 };
    }
    if (hx.length === 6 || hx.length === 8) {
      const v = (i) => parseInt(hx.slice(i, i + 2), 16);
      return { r: v(0), g: v(2), b: v(4), a: hx.length === 8 ? v(6) / 255 : 1 };
    }
    return null;
  }
  const alpha = (t) => {
    if (t === undefined) return 1;
    const x = t.trim();
    const n = x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
  };
  m = /^rgba?\(\s*([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length < 3) return null;
    const chan = (t) => (t.endsWith('%') ? (parseFloat(t) * 255) / 100 : parseFloat(t));
    const [r, g, b] = parts.slice(0, 3).map(chan);
    if (![r, g, b].every(Number.isFinite)) return null;
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: alpha(parts[3]) };
  }
  m = /^color\(\s*srgb\s+([^)]*)\)$/.exec(s);
  if (m) {
    const [rgb, a] = m[1].split('/');
    const parts = rgb.trim().split(/\s+/);
    if (parts.length < 3) return null;
    const chan = (t) => (t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t)) * 255;
    const [r, g, b] = parts.slice(0, 3).map(chan);
    if (![r, g, b].every(Number.isFinite)) return null;
    return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a: alpha(a) };
  }
  return null;
}

/** Composite `fg` (may be translucent) over an opaque `bg`. */
export function blend(fg, bg) {
  const a = fg.a === undefined ? 1 : fg.a;
  return {
    r: clamp255(fg.r * a + bg.r * (1 - a)),
    g: clamp255(fg.g * a + bg.g * (1 - a)),
    b: clamp255(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

/** Relative luminance (WCAG) of an RGB colour, 0..1. */
export function luminance({ r, g, b }) {
  const lin = (c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 'light' or 'dark' when a palette name says so (`dracula-dark`, `kiro-light`, `light`), else ''. */
export function kindFromName(name) {
  const m = /(?:^|[^a-z])(light|dark)(?:$|[^a-z])/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** dark or light from a background colour; '' when it cannot be parsed. */
export function kindFromBackground(bgHex) {
  const bg = parseColor(bgHex);
  if (!bg) return '';
  // 0.179 is where black and white text have equal contrast on the background.
  return luminance(bg) < 0.179 ? 'dark' : 'light';
}

/**
 * The dashboard's light/dark kind, always one of the two. In order: the
 * palette name on `data-theme`, the SDK's useTheme mode (pass it only when the
 * root really carries `data-theme`: with no attribute the SDK reports a
 * hard-coded 'dark', website/src/app-sdk/index.ts useTheme), the luminance of
 * `--bg`, the OS colour scheme, then dark.
 */
export function resolveKind({ themeName = '', sdkMode = '', bg = '', prefersDark } = {}) {
  return (
    kindFromName(themeName) ||
    kindFromName(sdkMode) ||
    kindFromBackground(bg) ||
    (prefersDark === true ? 'dark' : prefersDark === false ? 'light' : '') ||
    'dark'
  );
}

/** Back-compatible wrapper: kind from a background, the name breaking a tie. */
export function themeKind(bgHex, themeName = '') {
  return kindFromBackground(bgHex) || kindFromName(themeName) || 'dark';
}

/**
 * Build the POST /api/theme body from raw colour strings (already resolved by
 * the browser). `kind` is always present. `vars` holds only the tokens that
 * resolved to a colour, each as an opaque `#rrggbb` (translucent values are
 * composited over `--bg`); when none could be read the body is `{kind}` alone,
 * which tells the backend to use the stock VS Code Default Dark/Light theme.
 *
 * @param {Record<string,string>} raw  token name -> computed colour string
 * @param {string} themeName  `data-theme` of the dashboard root
 * @param {{sdkMode?: string, prefersDark?: boolean}} [hints]
 */
export function buildThemePayload(raw, themeName = '', hints = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const bgParsed = parseColor(src['--bg']);
  const nameKind = kindFromName(themeName) || kindFromName(hints.sdkMode);
  // A translucent background is put over white or black by the palette's kind.
  const base = nameKind === 'light' ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  const bg = bgParsed ? blend(bgParsed, base) : null;
  const vars = {};
  for (const name of THEME_VARS) {
    const c = parseColor(src[name]);
    if (!c) continue;
    // --bg itself goes over the base, everything else over the composited --bg.
    const under = name === '--bg' ? base : bg || base;
    const hex = rgbToHex(c.a < 1 ? blend(c, under) : c);
    if (/^#[0-9a-f]{6}$/.test(hex)) vars[name] = hex;
  }
  const kind = resolveKind({ themeName, sdkMode: hints.sdkMode, bg: vars['--bg'], prefersDark: hints.prefersDark });
  return Object.keys(vars).length ? { kind, vars } : { kind };
}

/** The folder a page URL asks for (`?folder=`), or '' when none. */
export function folderFromSearch(search) {
  try {
    const v = new URLSearchParams(search || '').get('folder');
    return v ? v.trim() : '';
  } catch {
    return '';
  }
}

/** The app page URL that opens VS Code on `folder` (the session control's target). */
export function appPageUrl(folder) {
  const f = typeof folder === 'string' ? folder.trim() : '';
  return f ? `${APP_ROUTE}?folder=${encodeURIComponent(f)}` : APP_ROUTE;
}

/**
 * Identity of the workbench load. The frame is reloaded only when this
 * changes: another folder (new URL), the Reload button (nonce) or a new server
 * generation, whose server cannot resume the old workbench session.
 */
export function frameKey(session, nonce) {
  if (!session || !session.ready || !session.url) return null;
  return `${session.url}#${nonce || 0}#${session.generation || 0}`;
}

/**
 * Where the detached frame host goes, and how it is clipped. `rect` is the
 * page's placeholder, `bounds` the visible area it may cover (the dashboard's
 * scrolling <main>, or the viewport). Returns null when nothing is visible.
 * The clip path keeps the frame inside `bounds` and rounds the corners named
 * in `radii` ([topLeft, topRight, bottomRight, bottomLeft]) to match the card.
 */
export function framePlacement(rect, bounds, radii = [0, 0, 0, 0]) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const top = Math.max(0, bounds.top - rect.top);
  const left = Math.max(0, bounds.left - rect.left);
  const bottom = Math.max(0, rect.top + rect.height - (bounds.top + bounds.height));
  const right = Math.max(0, rect.left + rect.width - (bounds.left + bounds.width));
  if (top + bottom >= rect.height || left + right >= rect.width) return null;
  const px = (n) => `${Math.round(n * 100) / 100}px`;
  const clip = `inset(${px(top)} ${px(right)} ${px(bottom)} ${px(left)} round ${radii.map(px).join(' ')})`;
  return {
    left: Math.round(rect.left * 100) / 100,
    top: Math.round(rect.top * 100) / 100,
    width: Math.round(rect.width * 100) / 100,
    height: Math.round(rect.height * 100) / 100,
    clip,
  };
}
