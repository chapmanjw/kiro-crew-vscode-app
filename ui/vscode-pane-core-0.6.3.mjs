// Pure helpers shared by the vscode-pane page and its session control. No React
// and no DOM access at import time, so node:test can load this file directly.
// The file name carries the version for the same cache reason as the page.

export const APP_NAME = 'vscode-pane';
export const APP_ROUTE = '/apps/vscode-pane';
export const API = '/apps/vscode-pane/api';

/**
 * The card's margin inside the dashboard's <main>, in px, matching how the
 * Kiro Crew Sessions card sits there (0.14 source, read 2026-11-15):
 *  - <main id="main-content"> has no padding (App.tsx: `p-0` on fixed-height
 *    routes, no padding class otherwise), and an app page renders straight
 *    into it (AppPage.tsx -> InstalledAppSurface, no wrapper padding).
 *  - The icon rail card is `mx-2 mt-0 mb-2` in its grid track
 *    (shell/nav/navRail.tsx), so its right edge is 8px short of <main> and its
 *    top is the top of the content row, under the 42px top bar.
 *  - The Sessions card has no margin of its own (components/listShell.ts
 *    LIST_SHELL_CLS) and its drawer adds only `pb-2`
 *    (components/OverlayDrawer.tsx), so it starts at <main>'s left and top:
 *    8px from the rail card, top aligned with it, bottom 8px up like the rail.
 * The right side keeps the 8px inset it had.
 *
 * The same values hold for the collapsed icon rail and the expanded sidebar:
 * both are one <nav> with the same `mx-2 mt-0 mb-2 rounded-xl` classes
 * (navRail.tsx:457); only its grid track changes, 74px or 236px
 * (hooks/useRailWidth.ts:20-21, App.tsx grid-template-columns). The shipped
 * 0.13.0-rc.1 bundle has the same classes and widths.
 */
export const CARD_MARGIN = Object.freeze({ top: 0, right: 8, bottom: 8, left: 0 });

/**
 * Height of the card's toolbar strip, border-box, including its 1px bottom
 * border. Kiro Crew lines panel headers up on one line 23px below the panel's
 * outer top (components/listShell.ts LIST_HEADER_CLS; shell/nav/railChrome.tsx),
 * and the expanded sidebar draws a hairline under its header at
 * 1 (card border) + 8 (pt-2) + 28 (w-7 h-7 logo row) + 6 (mb-1.5) + 2 (gap-0.5)
 * = 45px below its outer top (navRail.tsx:149-154). With the card's 1px top
 * border, a 45px strip puts our bottom border on that hairline (45-46px) and
 * our controls' centre on the 23px line (1 + 44 / 2).
 */
export const BAR_HEIGHT = 45;

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

/** A page tab id (backend/lib/tabs.mjs TAB_ID_RE). */
export const TAB_ID_RE = /^t[0-9a-f]{12}$/;
/** A session slot name (backend/lib/tabs.mjs SESSION_KEY_RE): the form the dashboard and its embed use. */
export const SESSION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * The slot name of a session key. The dashboard drops one `dashboard:` prefix, then
 * any `dashboard_` prefixes (its Du function), so `dashboard:chat-1` is `chat-1`.
 * The same rule as backend/lib/tabs.mjs slotOf.
 */
export function slotOfSession(key) {
  let t = typeof key === 'string' ? key.trim() : '';
  if (t.startsWith('dashboard:')) t = t.slice('dashboard:'.length);
  while (t.startsWith('dashboard_')) t = t.slice('dashboard_'.length);
  return t;
}

/**
 * The app page URL that opens VS Code on `folder` (the session control's
 * target). With `session` (the chat's key) the page opens, or brings back, the
 * tab for that chat, whose Kiro Crew view shows the chat.
 */
export function appPageUrl(folder, session) {
  const f = typeof folder === 'string' ? folder.trim() : '';
  const slot = slotOfSession(session);
  const s = SESSION_KEY_RE.test(slot) ? slot : '';
  const q = [f ? `folder=${encodeURIComponent(f)}` : '', s ? `session=${encodeURIComponent(s)}` : ''].filter(Boolean).join('&');
  return q ? `${APP_ROUTE}?${q}` : APP_ROUTE;
}

/**
 * What a page URL asks for: `{folder, session, tab}` (each '' when absent or
 * malformed), or null when it asks for nothing. `?session=` (with the chat's
 * `?folder=`) comes from the composer's VS Code chip, `?tab=` from "Open in VS
 * Code" in the file menus, `?folder=` alone from older links.
 */
export function intentFromSearch(search) {
  let q;
  try {
    q = new URLSearchParams(search || '');
  } catch {
    return null;
  }
  const folder = (q.get('folder') || '').trim();
  const s = slotOfSession(q.get('session'));
  const t = (q.get('tab') || '').trim();
  const session = SESSION_KEY_RE.test(s) ? s : '';
  const tab = TAB_ID_RE.test(t) ? t : '';
  if (!folder && !session && !tab) return null;
  return { folder, session, tab };
}

/** The last segment of a POSIX or Windows path (`C:\\x\\proj` -> `proj`), or the path itself for a root. */
export function baseName(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const name = i >= 0 ? s.slice(i + 1) : s;
  return name || String(p || '');
}

/**
 * The session titles the dashboard lists (the SDK's useHostSessions), as {slot: title}:
 * keyed by slot name, the form a tab stores its chat in.
 */
export function sessionTitles(sessions) {
  const out = {};
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (s && typeof s.key === 'string' && typeof s.title === 'string' && s.title.trim()) out[slotOfSession(s.key)] = s.title.trim().slice(0, 200);
  }
  return out;
}

/**
 * Each tab's label: the chat's title for a tab opened from a chat when the
 * dashboard shares it, else the folder's name. Labels that would repeat get
 * ` 2`, ` 3`... in tab order, so every tab can be told apart.
 * @returns {Record<string, string>} tab id -> label
 */
export function tabLabels(tabs, titles = {}) {
  const base = (Array.isArray(tabs) ? tabs : []).map((t) => [t.id, (t.session && titles[t.session]) || baseName(t.folder) || 'VS Code']);
  const seen = new Map();
  const out = {};
  for (const [id, label] of base) {
    const n = (seen.get(label) || 0) + 1;
    seen.set(label, n);
    out[id] = n > 1 ? `${label} ${n}` : label;
  }
  return out;
}

/** A tab's tooltip: the folder, and for a tab opened from a chat, which chat. */
export function tabTooltip(tab, titles = {}) {
  if (!tab) return '';
  if (!tab.session) return tab.folder;
  const title = titles[tab.session];
  return `${tab.folder}\nKiro Crew chat: ${title || tab.session}`;
}

/**
 * Identity of a tab's workbench load. The tab's frame is reloaded only when
 * this changes: Reload (nonce), a new server generation, a new launcher run
 * (`instance`, whose connection token the old workbench lacks), or a switch
 * between the frame port and the web origin. Not the folder: a tab's folder
 * changes only when VS Code itself opened another one, in that same frame.
 */
export function tabFrameKey({ id, nonce = 0, instance = '', generation = 0, mode = 'frame' }) {
  if (!id) return null;
  return `${id}#${nonce || 0}#${instance || ''}#${generation || 0}#${mode}`;
}

/** The URL a tab's frame loads: the tab's own workbench URL, or the same path on the web origin. */
export function frameUrlFor(url, session, mode, loc) {
  if (!url) return null;
  if (mode === 'origin') return webOriginUrl({ ...(session || {}), url }, loc) || null;
  return url;
}

/**
 * A tab's workbench URL with `vscpTab=<id>` added: the launcher tells the
 * window which tab it is from it (the kiroCrew.paneTab setting's default).
 * VS Code reads only its own query keys (folder, workspace, ew, payload).
 */
export function tabWorkbenchUrl(url, id) {
  if (!url || !TAB_ID_RE.test(id || '')) return url || null;
  // Appended as is, so the folder keeps the launcher's own encoding.
  const [base, hash] = String(url).split('#');
  return `${base}${base.includes('?') ? '&' : '?'}vscpTab=${id}${hash !== undefined ? `#${hash}` : ''}`;
}

/**
 * Identity of the workbench load. The frame is reloaded only when this
 * changes: another folder (new URL), the Reload button (nonce), a new server
 * generation, whose server cannot resume the old workbench session, or a new
 * launcher run (`instance`), whose connection token the old workbench lacks.
 * Generations restart at 1 in each run, so the run id is needed as well.
 */
export function frameKey(session, nonce) {
  if (!session || !session.ready || !session.url) return null;
  return `${session.url}#${nonce || 0}#${session.instance || ''}#${session.generation || 0}`;
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

/**
 * What the page shows when it cannot reach its own backend. The gateway answers
 * 502 "app 'vscode-pane' has no reachable backend" when it never started (or
 * lost) the launcher. The commonest cause is that the gateway found no `node`
 * (it looks through nvm, then its own PATH, and logs "no node binary found" in
 * gateway.log). The page cannot read that log, so the message names Node.js as
 * the likely cause and says where to confirm it. Any other session error is
 * passed through unchanged.
 *
 * @returns {{backendDown:boolean, title:string, message:string}}
 */
export function describeSessionError(errorText) {
  const text = String(errorText || '');
  if (!/no reachable backend/i.test(text)) {
    return { backendDown: false, title: 'VS Code could not start', message: text ? `Backend unreachable: ${text}` : '' };
  }
  return {
    backendDown: true,
    title: 'The VS Code backend is not running',
    message:
      'Kiro Crew did not start this app\'s backend. The usual cause is that Node.js is not installed, or is not on the PATH of the machine that runs the Kiro Crew gateway (an nvm-only install is not enough). ' +
      'To confirm, look for "no node binary found" in ~/.kiro/crew/gateway.log. ' +
      'Install Node.js 18 or later, or link node into a directory on the gateway\'s PATH, then disable and re-enable this app and use Check again.',
  };
}

/**
 * The reachability probe's URL: the launcher's frame origin plus the probe path
 * `/api/session` reports in `webOrigin.probe`. null when the session has none.
 */
export function probeUrl(session) {
  if (!session || !session.url || !session.webOrigin || !session.webOrigin.probe) return null;
  try {
    return `${new URL(session.url).origin}${session.webOrigin.probe}`;
  } catch {
    return null;
  }
}

/**
 * The workbench URL on the app's web origin: the gateway relays
 * `http://<app>.apps.localhost:<port of the dashboard as this browser reaches it>`
 * to the launcher, so a dashboard reached through a Remote Crew tunnel (or any
 * forward) needs no second port. The path and query are those of `session.url`.
 * `loc` is `{protocol, port}` of the dashboard page. null when it cannot be built
 * (no web origin, or a dashboard that is not plain http).
 */
export function webOriginUrl(session, loc) {
  if (!session || !session.url || !session.webOrigin || !session.webOrigin.host || !loc || loc.protocol !== 'http:') return null;
  try {
    const u = new URL(session.url);
    return `http://${session.webOrigin.host}${loc.port ? `:${loc.port}` : ''}${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}

/** The URL to load for the probe's verdict: 'frame' keeps `session.url`, 'origin' uses the web origin. */
export function chooseFrameUrl(session, mode, loc) {
  if (!session || !session.url) return null;
  if (mode === 'origin') return webOriginUrl(session, loc) || null;
  return session.url;
}

/**
 * What to tell the user when the gateway will not relay this app on the port the
 * browser reaches the dashboard on (GET /api/web-origin, lib/weborigin.mjs).
 * `port` is the dashboard's port as the browser sees it. null when all is well.
 *
 * @returns {{title:string, message:string, allow:boolean, restart:boolean, again:boolean}|null}
 */
export function webOriginAdvice(check, port) {
  if (!check || check.state === 'ok') return null;
  const p = String(port || check.port || '');
  const file = check.envFile || '~/.kiro/crew/.env';
  const variable = check.variable || 'KIROCREW_ALLOWED_LOOPBACK_PORTS';
  switch (check.state) {
    case 'port_not_allowed': {
      const listed = Array.isArray(check.listed) && check.listed.map(String).includes(p);
      return {
        title: 'One setting is needed on the machine that runs this Kiro Crew',
        message: listed
          ? `Port ${p}, the one you reach this Kiro Crew through, is already listed in ${file}, but the Kiro Crew running there has not read it yet. Restart Kiro Crew on that machine (run "kirocrew restart" there), then check again.`
          : `You reach this Kiro Crew through port ${p}. It serves app pages only on its own port and the ports listed in ${variable}. Allow port ${p} (this adds one line to ${file} on that machine), then restart Kiro Crew there.`,
        allow: !listed,
        restart: listed,
        again: true,
      };
    }
    case 'not_enabled':
      return {
        title: 'Kiro Crew is not serving this app\'s web address',
        message: 'The app\'s manifest asks for backend.webOrigin and the gateway has not picked it up. Update the app (Update on its page) or restart Kiro Crew, then check again.',
        allow: false, restart: false, again: true,
      };
    case 'refused':
      return {
        title: 'Kiro Crew refused the request for this app\'s web address',
        message: `${check.detail || 'The gateway answered 421'}. The gateway serves app pages only for direct loopback requests on its own dashboard ports, so a connection that arrives another way (the Session Manager listener, or through another proxy) cannot use them.`,
        allow: false, restart: false, again: true,
      };
    case 'gateway_unreachable':
      return {
        title: 'The app cannot reach its gateway',
        message: `${check.detail || 'No answer from the gateway on this machine'}. Restart the app from its page, then check again.`,
        allow: false, restart: false, again: true,
      };
    default:
      return {
        title: 'The web address check did not finish',
        message: check.error || check.detail || 'The check answered something unexpected.',
        allow: false, restart: false, again: true,
      };
  }
}

/** "VS Code 1.146.0" for a build {name, commit}, or the commit's first eight characters when the name is not known. */
export function buildLabel(build) {
  if (!build) return 'VS Code';
  return build.name ? `VS Code ${build.name}` : `VS Code ${String(build.commit || '').slice(0, 8)}`;
}

/** The menu's first line: what the VS Code server is doing (GET /api/session), or why the page cannot tell. */
export function serverStatusLine(session, problem) {
  if (problem) return problem.message || problem.title || '';
  if (!session) return 'Connecting to the vscode-pane backend...';
  if (session.ready) return `${buildLabel(session.server)} is running`;
  if (session.error) return `${session.message}: ${session.error}`;
  return session.message || session.status || '';
}

/** The page's update button: its label, and whether it is busy. */
export function updateButton(up) {
  const phase = up ? up.phase : null;
  if (phase === 'checking') return { label: 'Checking...', disabled: true };
  if (phase === 'downloading' || phase === 'restarting') return { label: 'Updating...', disabled: true };
  if (phase === 'current') return { label: 'Up to date', disabled: false };
  return { label: 'Check for updates', disabled: false };
}

/** The line under the toolbar for an update state: its text, its tone, and the install button when a newer build is out. Null when there is nothing to say. */
export function updateBanner(up) {
  if (!up) return null;
  switch (up.phase) {
    case 'available':
      return {
        tone: 'status',
        text: `${buildLabel(up.latest)} is available (you have ${buildLabel(up.installed)}). Updating downloads it, checks its SHA-256 and restarts the server with it. Newer builds can change the chat extension's proposed APIs, so check the chat afterwards.`,
        install: up.latest.commit,
        installLabel: `Update to ${up.latest.name || up.latest.commit.slice(0, 8)}`,
      };
    case 'downloading':
      return { tone: 'status', text: `${up.message || 'Downloading the new VS Code server'} (${buildLabel(up.latest)})`, install: null };
    case 'restarting':
      return { tone: 'status', text: `Restarting VS Code with ${buildLabel(up.installed)}...`, install: null };
    case 'done':
      return { tone: 'status', text: `Now running ${buildLabel(up.installed)}.`, install: null };
    case 'failed':
      return { tone: 'error', text: up.error || 'The update did not complete.', install: null };
    default:
      return null;
  }
}
