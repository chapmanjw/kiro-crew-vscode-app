// A colour theme the user picks in VS Code's own picker is theirs: it survives a
// reload, the page's own palette POST that comes with it, and the Kiro Crew theme
// changing, and picking the stock theme the palette is scoped to brings the
// palette back (extension/kiro-crew-bridge/theme.js, backend/lib/theme.mjs).
//
// Driven in the real workbench with the real picker (Ctrl+K Ctrl+T), after the
// theme checks of step 7. It ends on the stock theme the palette is scoped to,
// so the theme is Kiro Crew's own again for the steps after it.
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hexToRgb = (h) => `rgb(${[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ')})`;

export async function themePickChecks({ page, frame, api, dataDir, check }) {
  const machineFile = path.join(dataDir, 'server-data', 'data', 'Machine', 'settings.json');
  const machine = () => {
    try {
      return JSON.parse(fs.readFileSync(machineFile, 'utf8'));
    } catch {
      return {};
    }
  };
  /** The base theme the palette in the Machine settings is scoped to (`[Light Modern]` -> `Light Modern`), or ''. */
  const scopeTheme = () => (Object.keys(machine()['workbench.colorCustomizations'] || {})[0] || '').replace(/^\[(.*)\]$/, '$1');
  const palette = () => (machine()['workbench.colorCustomizations'] || {})[`[${scopeTheme()}]`] || {};
  const statusBar = () => frame.locator('.monaco-workbench .part.statusbar').first().evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => '');
  const baseClass = () => frame.locator('.monaco-workbench').first().evaluate((el) => /\b(vs-dark|vs|hc-black|hc-light)\b/.exec(el.className)?.[0] || '').catch(() => '');
  const themeEvent = async () => ((await api('GET', '/api/state')).json || {}).theme || null;
  const until = async (fn, ms = 20_000, step = 250) => {
    const t = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t > ms) return v;
      await sleep(step);
    }
  };
  async function pick(name) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let shown = false;
      for (let i = 0; i < 4 && !shown; i++) {
        await page.keyboard.press('Escape');
        await frame.locator('.monaco-workbench').click({ position: { x: 700, y: 300 } }).catch(() => {});
        await page.keyboard.press('Control+k');
        await sleep(250);
        await page.keyboard.press('Control+t');
        shown = await frame.locator('.quick-input-widget .quick-input-list').first().waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false);
      }
      if (!shown) continue;
      await page.keyboard.type(name);
      await sleep(900);
      await page.keyboard.press('Enter');
      if (await until(async () => machine()['workbench.colorTheme'] === name, 8000)) return true;
    }
    return false;
  }

  // 1. the pick
  const picked = await pick('Solarized Light');
  await sleep(1500);
  const paintedPick = await statusBar();
  const kiroStatus = (palette() || {})['statusBar.background'];
  check('a theme picked in VS Code is written to its settings and shows as that theme, without the Kiro Crew palette on it',
    picked && machine()['workbench.colorTheme'] === 'Solarized Light' && (await baseClass()) === 'vs' && !!kiroStatus && paintedPick !== hexToRgb(kiroStatus),
    `${machine()['workbench.colorTheme']} ${await baseClass()} ${paintedPick} (palette ${kiroStatus})`);

  // 2. a reload brings the window up again, and the page posts its palette on mount
  const eventBefore = await themeEvent();
  await page.reload();
  await frame.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
  const eventAfter = await until(async () => {
    const e = await themeEvent();
    return e && (!eventBefore || e.at > eventBefore.at) ? e : null;
  }, 45_000, 400);
  await sleep(4000);
  const finalEvent = await themeEvent();
  check('a reload leaves the picked theme alone: the extension reports it as the user\'s and changes nothing',
    !!eventAfter && machine()['workbench.colorTheme'] === 'Solarized Light' && !!finalEvent && finalEvent.applied === true && finalEvent.userTheme === true && finalEvent.readBack && finalEvent.readBack.colorTheme === 'Solarized Light',
    JSON.stringify(finalEvent && { applied: finalEvent.applied, changed: finalEvent.changed, userTheme: finalEvent.userTheme, rb: finalEvent.readBack && finalEvent.readBack.colorTheme }));
  check('the palette keeps following Kiro Crew behind the pick: it stays scoped to a stock theme, so it colours nothing else',
    /^(Dark|Light) Modern$/.test(scopeTheme()) && Object.keys(palette()).length > 100 && (await baseClass()) === 'vs',
    `${scopeTheme()} ${Object.keys(palette()).length} keys, ${await baseClass()}`);

  // 3. a Kiro Crew theme change while the pick stands: the other mode's palette, the same pick
  const was = scopeTheme();
  const flip = was === 'Dark Modern'
    ? { kind: 'light', vars: { '--bg': '#fbf7ef', '--surface': '#ffffff', '--panel': '#f2ecdf', '--border': '#d8cfbd', '--text': '#2b2620', '--muted': '#6f6658', '--accent': '#b4552d' } }
    : { kind: 'dark', vars: { '--bg': '#282a36', '--surface': '#343746', '--panel': '#21222c', '--border': '#44475a', '--text': '#f8f8f2', '--muted': '#a5a9c0', '--accent': '#bd93f9' } };
  const flipped = await api('POST', '/api/theme', flip);
  await sleep(2500);
  check('Kiro Crew changing its theme keeps the pick and moves the palette to the other stock theme',
    flipped.json && flipped.json.changed === true && machine()['workbench.colorTheme'] === 'Solarized Light' && scopeTheme() !== was && /^(Dark|Light) Modern$/.test(scopeTheme()),
    `${machine()['workbench.colorTheme']} ${was} -> ${scopeTheme()}`);

  // 4. picking the stock theme the palette is scoped to brings the palette back, live
  const target = scopeTheme();
  const back = await pick(target);
  await sleep(1500);
  const painted = await statusBar();
  const want = palette()['statusBar.background'];
  check('picking the stock theme the palette is scoped to brings the Kiro Crew palette back at once',
    back && machine()['workbench.colorTheme'] === target && !!want && painted === hexToRgb(want),
    `${machine()['workbench.colorTheme']} ${painted} want ${want && hexToRgb(want)}`);
}
