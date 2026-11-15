// Kiro Crew palette -> VS Code theme.
//
// The page posts the dashboard's resolved CSS variables (POST /api/theme). We
// validate them strictly, keep them in data/theme.json, and turn them into a
// base theme (Dark Modern / Light Modern, the 1.146 ids of the themes older
// builds called Default Dark Modern / Default Light Modern) plus a full
// `workbench.colorCustomizations` object. The bridge extension writes that to
// the user's settings; the launcher also seeds it into the server's Machine
// settings so the first paint is already themed. Pure functions only.

/**
 * Variables we accept. The first seven are the contract; the rest are other
 * names the dashboard defines on :root (KiroCrew website/src/lib/widgetSrcdoc.ts
 * THEME_VAR_NAMES, plus --panel/--chrome/--card from the theme CSS).
 */
export const THEME_KEYS = Object.freeze([
  '--bg', '--surface', '--panel', '--border', '--text', '--muted', '--accent',
  '--bg-elevated', '--bg-hover', '--card', '--card-fg', '--chrome',
  '--text-strong', '--muted-strong', '--border-strong',
  '--accent-hover', '--accent-subtle',
  '--ok', '--warn', '--danger', '--info',
]);
export const REQUIRED_KEYS = Object.freeze(['--bg', '--text']);
export const MAX_THEME_BYTES = 4096;

export const BASE_THEMES = Object.freeze({ dark: 'Dark Modern', light: 'Light Modern' });

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Normalise #rgb / #rrggbb / #rrggbbaa to lower-case #rrggbb or #rrggbbaa. */
export function normalizeHex(v) {
  if (typeof v !== 'string' || !HEX.test(v.trim())) return null;
  let h = v.trim().slice(1).toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return '#' + h;
}

/**
 * Validate a POST /api/theme body. Known keys only, hex colours only, a size
 * cap, and the two required keys. Returns {theme} or {error}.
 * @param {unknown} body parsed JSON
 * @param {number} [rawSize] request body size in bytes
 */
export function validateTheme(body, rawSize = 0) {
  if (rawSize > MAX_THEME_BYTES) return { error: `theme body over ${MAX_THEME_BYTES} bytes` };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const extra = Object.keys(body).filter((k) => k !== 'kind' && k !== 'vars');
  if (extra.length) return { error: `unknown field ${JSON.stringify(extra[0])}` };
  if (body.kind !== 'dark' && body.kind !== 'light') return { error: 'kind must be "dark" or "light"' };
  const vars = body.vars;
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return { error: 'vars must be an object' };
  const out = {};
  for (const [k, v] of Object.entries(vars)) {
    if (!THEME_KEYS.includes(k)) return { error: `unknown variable ${JSON.stringify(k.slice(0, 40))}` };
    const hex = normalizeHex(v);
    if (!hex) return { error: `${k} must be a hex colour (#rgb, #rrggbb or #rrggbbaa)` };
    out[k] = hex;
  }
  for (const k of REQUIRED_KEYS) if (!out[k]) return { error: `${k} is required` };
  return { theme: { kind: body.kind, vars: sortKeys(out) } };
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

// ---------------------------------------------------------------- colour maths

function rgb(hex) {
  const h = normalizeHex(hex).slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function toHex([r, g, b]) {
  return '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
}
/** Mix a toward b by t (0..1). Alpha of the inputs is ignored. */
export function mix(a, b, t) {
  const x = rgb(a);
  const y = rgb(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * t));
}
/** #rrggbb plus an alpha byte. */
export function alpha(hex, a) {
  return normalizeHex(hex).slice(0, 7) + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
}
/** WCAG relative luminance. */
export function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
/** Black or white, whichever reads better on `bg`. */
export function onColor(bg) {
  return contrast(bg, '#ffffff') >= contrast(bg, '#000000') ? '#ffffff' : '#000000';
}

/**
 * Fill the palette: every name the mapping uses gets a value, derived from
 * --bg/--text/--accent when the page did not send it.
 */
export function derivePalette({ kind, vars }) {
  const v = { ...vars };
  const bg = v['--bg'];
  const text = v['--text'];
  const dark = kind === 'dark';
  // Kiro Crew's chrome is darker than its cards in dark themes and the other
  // way round in light ones; derive toward the text colour for surfaces.
  const lift = (t) => mix(bg, text, t);
  const accent = v['--accent'] || (dark ? '#7c9cff' : '#3b5bdb');
  return {
    bg,
    text,
    accent,
    accentFg: onColor(accent),
    accentHover: v['--accent-hover'] || mix(accent, dark ? '#ffffff' : '#000000', 0.12),
    selection: v['--accent-subtle'] || alpha(accent, dark ? 0.35 : 0.25),
    surface: v['--surface'] || v['--card'] || lift(dark ? 0.06 : 0.03),
    panel: v['--panel'] || v['--bg-elevated'] || lift(dark ? 0.04 : 0.02),
    chrome: v['--chrome'] || (dark ? mix(bg, '#000000', 0.18) : mix(bg, '#000000', 0.03)),
    border: v['--border'] || lift(dark ? 0.16 : 0.14),
    muted: v['--muted'] || mix(text, bg, 0.4),
    hover: v['--bg-hover'] || lift(dark ? 0.1 : 0.06),
    textStrong: v['--text-strong'] || text,
    danger: v['--danger'] || (dark ? '#f87171' : '#c62828'),
    warn: v['--warn'] || (dark ? '#fbbf24' : '#b26a00'),
    ok: v['--ok'] || (dark ? '#4ade80' : '#2e7d32'),
    info: v['--info'] || v['--accent'] || (dark ? '#60a5fa' : '#1565c0'),
  };
}

/**
 * The VS Code side of the theme: a base theme name and a full
 * workbench.colorCustomizations object (editor, side bar, activity bar, title
 * bar, status bar, panel, tabs, lists, inputs, buttons, focus border, chat and
 * terminal background).
 */
export function toVsCodeTheme(theme) {
  const p = derivePalette(theme);
  const c = {
    // base
    foreground: p.text,
    descriptionForeground: p.muted,
    disabledForeground: alpha(p.muted, 0.6),
    errorForeground: p.danger,
    focusBorder: p.accent,
    contrastBorder: '#00000000',
    'widget.border': p.border,
    'widget.shadow': alpha('#000000', theme.kind === 'dark' ? 0.36 : 0.16),
    'selection.background': p.selection,
    'icon.foreground': p.muted,
    'textLink.foreground': p.accent,
    'textLink.activeForeground': p.accentHover,
    'sash.hoverBorder': p.accent,
    'progressBar.background': p.accent,
    'scrollbarSlider.background': alpha(p.muted, 0.25),
    'scrollbarSlider.hoverBackground': alpha(p.muted, 0.4),
    'scrollbarSlider.activeBackground': alpha(p.muted, 0.55),
    // editor
    'editor.background': p.bg,
    'editor.foreground': p.text,
    'editorGutter.background': p.bg,
    'editorLineNumber.foreground': alpha(p.muted, 0.7),
    'editorLineNumber.activeForeground': p.text,
    'editor.lineHighlightBackground': alpha(p.hover, 0.6),
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': p.selection,
    'editor.inactiveSelectionBackground': alpha(p.accent, 0.15),
    'editor.findMatchHighlightBackground': alpha(p.warn, 0.3),
    'editorCursor.foreground': p.accent,
    'editorIndentGuide.background1': alpha(p.border, 0.6),
    'editorIndentGuide.activeBackground1': p.border,
    'editorWidget.background': p.surface,
    'editorWidget.foreground': p.text,
    'editorWidget.border': p.border,
    'editorHoverWidget.background': p.surface,
    'editorHoverWidget.border': p.border,
    'editorSuggestWidget.background': p.surface,
    'editorSuggestWidget.border': p.border,
    'editorSuggestWidget.selectedBackground': p.hover,
    'editorGroup.border': p.border,
    'editorGroupHeader.tabsBackground': p.chrome,
    'editorGroupHeader.tabsBorder': p.border,
    'editorGroupHeader.noTabsBackground': p.chrome,
    'editorError.foreground': p.danger,
    'editorWarning.foreground': p.warn,
    'editorInfo.foreground': p.info,
    'breadcrumb.background': p.bg,
    'breadcrumb.foreground': p.muted,
    'breadcrumb.focusForeground': p.text,
    'peekView.border': p.accent,
    'peekViewEditor.background': p.panel,
    'peekViewResult.background': p.surface,
    // tabs
    'tab.activeBackground': p.bg,
    'tab.activeForeground': p.textStrong,
    'tab.activeBorderTop': p.accent,
    'tab.activeBorder': p.bg,
    'tab.inactiveBackground': p.chrome,
    'tab.inactiveForeground': p.muted,
    'tab.hoverBackground': p.hover,
    'tab.border': p.border,
    'tab.unfocusedActiveForeground': p.text,
    // side bar, activity bar
    'sideBar.background': p.panel,
    'sideBar.foreground': p.text,
    'sideBar.border': p.border,
    'sideBarTitle.foreground': p.muted,
    'sideBarSectionHeader.background': p.panel,
    'sideBarSectionHeader.foreground': p.text,
    'sideBarSectionHeader.border': p.border,
    'activityBar.background': p.chrome,
    'activityBar.foreground': p.text,
    'activityBar.inactiveForeground': p.muted,
    'activityBar.border': p.border,
    'activityBar.activeBorder': p.accent,
    'activityBarBadge.background': p.accent,
    'activityBarBadge.foreground': p.accentFg,
    'activityBarTop.foreground': p.text,
    'activityBarTop.activeBorder': p.accent,
    // title bar, menus, command center
    'titleBar.activeBackground': p.chrome,
    'titleBar.activeForeground': p.text,
    'titleBar.inactiveBackground': p.chrome,
    'titleBar.inactiveForeground': p.muted,
    'titleBar.border': p.border,
    'menu.background': p.surface,
    'menu.foreground': p.text,
    'menu.selectionBackground': p.hover,
    'menu.selectionForeground': p.text,
    'menu.border': p.border,
    'menu.separatorBackground': p.border,
    'menubar.selectionBackground': p.hover,
    'commandCenter.background': p.panel,
    'commandCenter.foreground': p.text,
    'commandCenter.border': p.border,
    'commandCenter.activeBackground': p.hover,
    'quickInput.background': p.surface,
    'quickInput.foreground': p.text,
    'quickInputTitle.background': p.panel,
    'pickerGroup.foreground': p.accent,
    'pickerGroup.border': p.border,
    // status bar
    'statusBar.background': p.chrome,
    'statusBar.foreground': p.muted,
    'statusBar.border': p.border,
    'statusBar.noFolderBackground': p.chrome,
    'statusBar.debuggingBackground': p.warn,
    'statusBar.debuggingForeground': onColor(p.warn),
    'statusBarItem.hoverBackground': p.hover,
    'statusBarItem.remoteBackground': p.accent,
    'statusBarItem.remoteForeground': p.accentFg,
    'statusBarItem.prominentBackground': p.hover,
    // panel, terminal
    'panel.background': p.panel,
    'panel.border': p.border,
    'panelTitle.activeForeground': p.text,
    'panelTitle.activeBorder': p.accent,
    'panelTitle.inactiveForeground': p.muted,
    'panelInput.border': p.border,
    'panelSectionHeader.background': p.panel,
    'terminal.background': p.panel,
    'terminal.foreground': p.text,
    'terminal.border': p.border,
    'terminalCursor.foreground': p.accent,
    'terminal.selectionBackground': p.selection,
    // lists and trees
    'list.activeSelectionBackground': alpha(p.accent, 0.28),
    'list.activeSelectionForeground': p.textStrong,
    'list.activeSelectionIconForeground': p.textStrong,
    'list.inactiveSelectionBackground': p.hover,
    'list.inactiveSelectionForeground': p.text,
    'list.hoverBackground': alpha(p.hover, 0.8),
    'list.hoverForeground': p.text,
    'list.focusOutline': p.accent,
    'list.focusBackground': alpha(p.accent, 0.18),
    'list.highlightForeground': p.accent,
    'list.dropBackground': alpha(p.accent, 0.2),
    'list.errorForeground': p.danger,
    'list.warningForeground': p.warn,
    'tree.indentGuidesStroke': p.border,
    // inputs, dropdowns, checkboxes
    'input.background': p.surface,
    'input.foreground': p.text,
    'input.border': p.border,
    'input.placeholderForeground': alpha(p.muted, 0.85),
    'inputOption.activeBorder': p.accent,
    'inputOption.activeBackground': alpha(p.accent, 0.25),
    'inputValidation.errorBorder': p.danger,
    'inputValidation.errorBackground': p.surface,
    'dropdown.background': p.surface,
    'dropdown.foreground': p.text,
    'dropdown.border': p.border,
    'dropdown.listBackground': p.surface,
    'checkbox.background': p.surface,
    'checkbox.border': p.border,
    'checkbox.foreground': p.text,
    'settings.headerForeground': p.textStrong,
    'settings.modifiedItemIndicator': p.accent,
    'keybindingLabel.background': p.hover,
    'keybindingLabel.foreground': p.text,
    'keybindingLabel.border': p.border,
    'keybindingLabel.bottomBorder': p.border,
    // buttons, badges
    'button.background': p.accent,
    'button.foreground': p.accentFg,
    'button.hoverBackground': p.accentHover,
    'button.border': '#00000000',
    'button.secondaryBackground': p.hover,
    'button.secondaryForeground': p.text,
    'button.secondaryHoverBackground': mix(p.hover, p.text, 0.08),
    'badge.background': p.accent,
    'badge.foreground': p.accentFg,
    // notifications, dialogs
    'notifications.background': p.surface,
    'notifications.foreground': p.text,
    'notifications.border': p.border,
    'notificationCenterHeader.background': p.panel,
    'notificationToast.border': p.border,
    // welcome page and chat
    'welcomePage.background': p.bg,
    'welcomePage.tileBackground': p.surface,
    'welcomePage.tileHoverBackground': p.hover,
    'welcomePage.tileBorder': p.border,
    'chat.requestBackground': alpha(p.surface, 0.8),
    'chat.requestBorder': p.border,
    'chat.slashCommandBackground': alpha(p.accent, 0.2),
    'chat.slashCommandForeground': p.accent,
    'chat.avatarBackground': p.surface,
    'chat.avatarForeground': p.text,
    'chat.editedFileForeground': p.warn,
    'interactive.activeCodeBorder': p.accent,
    'interactive.inactiveCodeBorder': p.border,
    'interactiveEditor.border': p.border,
    'inlineChat.background': p.surface,
    'inlineChat.border': p.border,
    'inlineChatInput.background': p.surface,
    'inlineChatInput.border': p.border,
    // git decorations and minimap stay with the base theme
  };
  return { colorTheme: BASE_THEMES[theme.kind], colorCustomizations: sortKeys(c) };
}

/** Stable JSON for change detection. */
export function themeSignature(vsTheme) {
  return JSON.stringify(vsTheme);
}

/**
 * Seed the server's Machine settings.json with the theme (window-scoped
 * settings from the remote's Machine settings apply on first paint). Other
 * settings are kept; returns null when the file is not plain JSON.
 */
export function seedThemeSettings(existingText, vsTheme, extra = {}) {
  let obj = {};
  if (existingText && existingText.trim()) {
    try {
      obj = JSON.parse(existingText);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  }
  if (vsTheme) {
    obj['workbench.colorTheme'] = vsTheme.colorTheme;
    obj['workbench.colorCustomizations'] = vsTheme.colorCustomizations;
  }
  Object.assign(obj, extra);
  return JSON.stringify(obj, null, 2) + '\n';
}
