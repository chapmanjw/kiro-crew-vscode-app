// Putting the Kiro Crew theme into VS Code's settings, and whose colour theme it is.
//
// Kiro Crew's colours are a palette, `workbench.colorCustomizations`, and VS Code
// lays customizations over whichever colour theme is selected. A flat palette
// would sit on a theme the user picked and give a mix of the two. So the palette
// is written scoped to the stock theme it was made for, `{"[Dark Modern]": {...}}`,
// and VS Code applies it only while that theme is selected.
//
// The scope key also records which stock theme Kiro Crew chose last. A colour
// theme that is anything else was chosen by the user, and Kiro Crew leaves
// `workbench.colorTheme` alone from then on. It keeps the scoped palette current,
// so picking the stock theme that matches Kiro Crew's mode brings the palette
// back, and resetting the setting hands the theme back to Kiro Crew.
//
// The launcher (backend/lib/theme.mjs, for the Machine settings it seeds) and the
// extension (applyTheme below) share these rules.
'use strict';

/** The stock themes Kiro Crew builds on, under both names VS Code has given them. */
const STOCK_THEMES = ['Dark Modern', 'Light Modern', 'Default Dark Modern', 'Default Light Modern'];

/** "Dark Modern" and "Default Dark Modern" are one theme: 1.146 dropped the prefix. */
function themeKey(name) {
  return typeof name === 'string' ? name.replace(/^Default /, '') : '';
}

function sameTheme(a, b) {
  const x = themeKey(a);
  return x !== '' && x === themeKey(b);
}

function isStockTheme(name) {
  return typeof name === 'string' && STOCK_THEMES.includes(name);
}

/** The key that scopes customizations to one theme: `[Dark Modern]`. */
function scopeKey(theme) {
  return `[${theme}]`;
}

/**
 * The value of `workbench.colorCustomizations` for a theme: the palette scoped to
 * that theme. A theme with no palette (tier "base") still gets its key, empty, so
 * the settings keep saying which stock theme Kiro Crew chose.
 */
function scopedPalette(theme, palette) {
  return { [scopeKey(theme)]: palette && typeof palette === 'object' && !Array.isArray(palette) ? palette : {} };
}

/** The stock themes a customizations value holds a scoped palette for. */
function scopedThemes(customizations) {
  if (!customizations || typeof customizations !== 'object' || Array.isArray(customizations)) return [];
  const out = [];
  for (const key of Object.keys(customizations)) {
    const m = /^\[(.+)\]$/.exec(key);
    if (m && isStockTheme(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Whether the colour theme the settings hold is Kiro Crew's to set.
 *   nothing chosen yet                    yes
 *   a scoped palette is in the settings   yes while the colour theme is the one it is scoped to
 *   no scoped palette (a build before the palette was scoped, or none)
 *                                         yes while the colour theme is a stock theme
 * @param {unknown} current  `workbench.colorTheme` as the settings hold it
 * @param {unknown} customizations  `workbench.colorCustomizations` as the settings hold it
 */
function kiroCrewOwnsTheme(current, customizations) {
  if (typeof current !== 'string' || current === '') return true;
  const scoped = scopedThemes(customizations);
  if (scoped.length) return scoped.some((s) => sameTheme(s, current));
  return isStockTheme(current);
}

/** Stable JSON, so two objects with the same content compare equal. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

/**
 * The id this VS Code uses for a built-in theme. 1.146 contributes "Dark
 * Modern"/"Light Modern" where older builds had "Default Dark Modern"/"Default
 * Light Modern", and the workbench rewrites a setting that names the other
 * form, which would make every check look like a change.
 */
function resolveThemeId(vscode, name) {
  const ids = new Set();
  for (const ext of vscode.extensions.all) {
    for (const th of ext.packageJSON?.contributes?.themes || []) if (th.id || th.label) ids.add(th.id || th.label);
  }
  const bare = themeKey(name);
  for (const candidate of [name, bare, `Default ${bare}`]) if (ids.has(candidate)) return candidate;
  return name;
}

/**
 * Write the Kiro Crew theme into the user settings, only where it differs, so an
 * unchanged theme never touches settings.json. A colour theme the user chose is
 * not replaced; only the scoped palette is kept current.
 * @param {object} o
 * @param {object} o.vscode  the `vscode` module
 * @param {object} o.payload  `{colorTheme, colorCustomizations, signature}` from the launcher
 * @param {(ev: object) => Promise<unknown>} o.postEvent  reports the result to the launcher
 * @param {(msg: string) => void} o.log
 * @returns {Promise<{changed: boolean, owned: boolean}>}
 */
async function applyTheme({ vscode, payload, postEvent, log }) {
  if (!payload || typeof payload.colorTheme !== 'string' || !payload.colorCustomizations || typeof payload.colorCustomizations !== 'object') {
    throw new Error('bad theme payload');
  }
  const t = { ...payload, colorTheme: resolveThemeId(vscode, payload.colorTheme) };
  const cfg = vscode.workspace.getConfiguration();
  const target = vscode.ConfigurationTarget.Global;
  let changed = false;
  let owned = true;
  const why = [];
  try {
    const curTheme = cfg.inspect('workbench.colorTheme')?.globalValue;
    const curCust = cfg.inspect('workbench.colorCustomizations')?.globalValue;
    // Decided before anything is written: the palette's scope key is what says which theme Kiro Crew chose last.
    owned = kiroCrewOwnsTheme(curTheme, curCust);
    if (owned && curTheme !== t.colorTheme) {
      why.push(`colorTheme ${curTheme} -> ${t.colorTheme}`);
      await cfg.update('workbench.colorTheme', t.colorTheme, target);
      changed = true;
    } else if (!owned) {
      why.push(`kept ${curTheme}, chosen in VS Code`);
    }
    const scope = scopeKey(t.colorTheme);
    const wanted = scopedPalette(t.colorTheme, t.colorCustomizations);
    const current = curCust && typeof curCust === 'object' && Object.keys(curCust).length ? curCust : null;
    if (stable(current) !== stable(wanted)) {
      const slice = (o) => (o && o[scope] && typeof o[scope] === 'object' ? o[scope] : {});
      const had = slice(current);
      const palette = wanted[scope];
      const diff = Object.keys(palette).find((k) => had[k] !== palette[k]) || Object.keys(had).find((k) => !(k in palette)) || '(other scopes)';
      why.push(`colorCustomizations ${Object.keys(had).length} keys -> ${Object.keys(palette).length}, first difference ${diff}`);
      await cfg.update('workbench.colorCustomizations', wanted, target);
      changed = true;
    }
    log(`theme ${changed ? 'applied' : 'unchanged'} (${t.colorTheme})${why.length ? ': ' + why.join('; ') : ''}`);
    // Read the settings back from a fresh configuration snapshot, so the
    // launcher (and its smoke test) sees what VS Code itself now holds.
    const now = vscode.workspace.getConfiguration();
    const cust = now.get('workbench.colorCustomizations') || {};
    const scoped = cust[scope] && typeof cust[scope] === 'object' ? cust[scope] : {};
    const readBack = {
      colorTheme: now.get('workbench.colorTheme'),
      editorBackground: scoped['editor.background'] || null,
      count: Object.keys(scoped).length,
    };
    await postEvent({ type: 'theme', signature: t.signature, applied: true, changed, userTheme: !owned, readBack });
    return { changed, owned };
  } catch (e) {
    await postEvent({ type: 'theme', signature: t.signature, applied: false, error: e.message });
    throw e;
  }
}

module.exports = {
  STOCK_THEMES,
  sameTheme,
  isStockTheme,
  scopeKey,
  scopedPalette,
  scopedThemes,
  kiroCrewOwnsTheme,
  resolveThemeId,
  applyTheme,
};
