// Smoke checks for the bridge extension's icons inside VS Code: the copy the
// launcher installs carries them, the Extensions view shows the Kiro Crew PNG,
// and the Kiro Crew view container uses the currentColor ghost.
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function extensionIconChecks({ page, frame, check, appRoot, dataDir, shotDir }) {
  const src = path.join(appRoot, 'extension', 'kiro-crew-bridge');
  const extDir = path.join(dataDir, 'extensions');
  const installed = (fs.existsSync(extDir) ? fs.readdirSync(extDir) : []).filter((n) => /^kiro-crew\.kiro-crew-bridge-|^kiro-crew-bridge/.test(n));
  const dir = installed.length ? path.join(extDir, installed[0]) : '';
  const same = (rel) => dir && fs.existsSync(path.join(dir, rel)) && fs.readFileSync(path.join(dir, rel)).equals(fs.readFileSync(path.join(src, rel)));
  check('the installed bridge extension carries its Kiro Crew icon.png and media/kiro-crew.svg unchanged',
    !!dir && same('icon.png') && same('media/kiro-crew.svg'), dir ? path.basename(dir) : `nothing in ${extDir}: ${installed}`);

  // The Extensions view: the bridge's row shows its own icon.png. The primary
  // side bar is put back on the view it showed before, so later checks see
  // the workbench as it was.
  const activeBar = () => frame.locator('.part.activitybar .action-item').evaluateAll((els) => {
    const on = els.find((e) => e.classList.contains('checked') || e.querySelector('.action-label.checked'));
    return on ? ((on.querySelector('.action-label') || on).getAttribute('aria-label') || '') : '';
  }).catch(() => '');
  const barBefore = await activeBar();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+KeyP');
  await frame.locator('.quick-input-widget input').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  await page.keyboard.type('Extensions: Show Installed Extensions', { delay: 5 });
  await sleep(700);
  await page.keyboard.press('Enter');
  let row = null;
  const t = Date.now();
  while (Date.now() - t < 15_000) {
    row = await frame.locator('.extensions-viewlet .monaco-list-row').evaluateAll((els) => {
      const r = els.find((e) => /Kiro Crew Bridge/.test(e.getAttribute('aria-label') || e.textContent || ''));
      if (!r) return null;
      const img = r.querySelector('img.icon, .icon-container img');
      return img ? { src: img.getAttribute('src') || '', w: img.naturalWidth, shown: img.complete && img.naturalWidth > 0 && getComputedStyle(img).visibility !== 'hidden' } : { src: '', w: 0, shown: false };
    }).catch(() => null);
    if (row && row.shown) break;
    await sleep(500);
  }
  await page.screenshot({ path: `${shotDir}/extensions-view.png` }).catch(() => {});
  const barNow = await activeBar();
  if (barNow !== barBefore) {
    // Clicking the earlier entry shows that view again; clicking the active
    // Extensions entry closes the side bar when nothing was open before.
    const target = barBefore || barNow;
    await frame.locator('.part.activitybar .action-label').evaluateAll((els, t) => { const el = els.find((e) => e.getAttribute('aria-label') === t); if (el) el.click(); }, target).catch(() => {});
    await sleep(500);
  }
  check('VS Code\'s Extensions view shows the bridge with its Kiro Crew icon.png',
    !!row && row.shown && /icon\.png/.test(row.src) && row.w >= 128, JSON.stringify(row && { src: row.src.slice(-60), w: row.w, shown: row.shown }));

  // The view container icon. VS Code draws container icons in the secondary
  // side bar only with workbench.secondarySideBar.showLabels off (default on:
  // titles instead of icons), painting the SVG as a CSS mask. Turn labels off
  // in the server's Machine settings for the check, then put the file back.
  const machineFile = path.join(dataDir, 'server-data', 'data', 'Machine', 'settings.json');
  const before = fs.existsSync(machineFile) ? fs.readFileSync(machineFile, 'utf8') : null;
  const activeAux = () => frame.locator('.part.auxiliarybar .composite-bar .action-item').evaluateAll((els) => {
    const on = els.find((e) => e.classList.contains('checked') || e.querySelector('.action-label.checked'));
    return on ? ((on.querySelector('.action-label') || on).getAttribute('aria-label') || '') : '';
  }).catch(() => '');
  const auxBefore = await activeAux();
  let container = { hits: [], rules: 0 };
  try {
    const settings = before ? JSON.parse(before) : {};
    fs.writeFileSync(machineFile, JSON.stringify({ ...settings, 'workbench.secondarySideBar.showLabels': false }, null, 2));
    // Every container pinned in the bar gets its icon; nothing is opened, so
    // the checks after this one see the side bars as they were.
    const t2 = Date.now();
    while (Date.now() - t2 < 10_000) {
      container = await frame.locator('.monaco-workbench').evaluate(() => {
        const hits = [];
        for (const el of document.querySelectorAll('.composite-bar .action-label')) {
          const cs = getComputedStyle(el);
          if (/kiro-crew\.svg/.test(`${cs.maskImage || ''} ${cs.getPropertyValue('-webkit-mask-image') || ''}`)) hits.push((el.getAttribute('aria-label') || '').slice(0, 40));
        }
        const rules = [...document.styleSheets].flatMap((s) => { try { return [...s.cssRules].map((r) => r.cssText); } catch { return []; } })
          .filter((t) => /kiro-crew\.svg/.test(t));
        return { hits, rules: rules.length };
      }).catch(() => ({ hits: [], rules: 0 }));
      if (container.hits.length) break;
      await sleep(500);
    }
    await page.screenshot({ path: `${shotDir}/kiro-crew-container.png` }).catch(() => {});
  } finally {
    if (before === null) fs.rmSync(machineFile, { force: true });
    else fs.writeFileSync(machineFile, before);
  }
  // Labels back on: put the secondary side bar back on the tab it showed.
  await sleep(1500);
  if (auxBefore && (await activeAux()) !== auxBefore) {
    await frame.locator('.part.auxiliarybar .composite-bar .action-label').evaluateAll((els, t) => { const el = els.find((e) => e.getAttribute('aria-label') === t); if (el) el.click(); }, auxBefore).catch(() => {});
  }
  check('with secondary side bar labels off, the Kiro Crew view container shows media/kiro-crew.svg as its icon', container.hits.length > 0, JSON.stringify(container));
  await page.keyboard.press('Escape');
}
