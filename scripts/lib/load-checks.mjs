// Smoke checks for the pane's first paint (0.5.3): while the VS Code workbench
// loads, the frame area shows the Kiro Crew theme's background and never a
// white canvas, and the iframe stays hidden until its page has loaded.
//
// The workbench page request is held for a moment so the loading state lasts
// long enough to sample; the sampler screenshots the page every ~120 ms and
// reads the frame area (the pane's frame slot) and the iframe's state.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NEAR_WHITE = 235; // every channel at or above this

/** Fraction of near-white pixels on a grid over `rect`, and the colour at its centre. */
export function sampleArea(img, rect) {
  const x0 = Math.max(0, Math.floor(rect.left) + 4);
  const x1 = Math.min(img.width - 1, Math.floor(rect.right) - 4);
  const y0 = Math.max(0, Math.floor(rect.top) + 4);
  const y1 = Math.min(img.height - 1, Math.floor(rect.bottom) - 4);
  let n = 0;
  let white = 0;
  for (let y = y0; y <= y1; y += 6) {
    for (let x = x0; x <= x1; x += 6) {
      const [r, g, b] = img.px(x, y);
      n++;
      if (r >= NEAR_WHITE && g >= NEAR_WHITE && b >= NEAR_WHITE) white++;
    }
  }
  const centre = img.px(Math.floor((x0 + x1) / 2), Math.floor((y0 + y1) / 2));
  return { n, white, centre };
}

/**
 * Hold the workbench document and start sampling. Call before the page opens
 * the dashboard; `stop()` after the workbench is up returns the samples.
 */
export async function startLoadWatch({ page, framePort, holdMs = 2500 }) {
  let held = false;
  const handler = async (route) => {
    held = true;
    await sleep(holdMs);
    await route.continue().catch(() => {});
  };
  const match = (u) => u.hostname === '127.0.0.1' && u.port === String(framePort) && /^\/vsc-[^/]+\/$/.test(u.pathname);
  await page.route(match, handler);
  const samples = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const st = await page.evaluate(() => {
          const wrap = document.querySelector('div[data-vscode-pane-frame-host]');
          const slot = document.querySelector('[data-testid="vscode-pane-frame-slot"]');
          const iframe = wrap && wrap.querySelector('iframe');
          if (!wrap || !slot || !iframe) return null;
          const b = wrap.getBoundingClientRect();
          return {
            placed: wrap.getAttribute('data-visible') === 'true' && b.width > 100 && b.height > 100,
            ready: iframe.getAttribute('data-ready'),
            hasSrc: !!iframe.getAttribute('src'),
            opacity: getComputedStyle(iframe).opacity,
            scheme: getComputedStyle(wrap).colorScheme,
            rect: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
          };
        });
        if (st && st.placed) {
          const png = await page.screenshot();
          samples.push({ ...st, ...sampleArea(decodePng(png), st.rect), png });
        }
      } catch {
        /* the page is navigating */
      }
      await sleep(120);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      await page.unroute(match, handler).catch(() => {});
      return { samples, held };
    },
  };
}

/** The checks over the samples. `expectBg` is the dashboard's --bg as [r, g, b]. */
export function loadChecks({ result, expectBg, shotDir, check }) {
  const { samples, held } = result;
  const loading = samples.filter((s) => s.ready === 'false' && s.hasSrc);
  check('the workbench page request was held, so the loading state could be sampled', held && loading.length >= 3, `held ${held}; ${loading.length} samples while the frame was loading of ${samples.length}`);
  check('the iframe stays hidden (opacity 0) in every sample taken before its page has loaded',
    loading.length > 0 && loading.every((s) => s.opacity === '0'), JSON.stringify([...new Set(loading.map((s) => s.opacity))]));
  const whites = loading.filter((s) => s.white > 0);
  check('dark theme: no near-white pixel anywhere in the frame area while the workbench loads', loading.length > 0 && whites.length === 0,
    whites.length ? `${whites.length} samples, first has ${whites[0].white}/${whites[0].n} near-white` : `${loading.length} samples, ${loading[0] ? loading[0].n : 0} points each`);
  const off = loading.filter((s) => s.centre.some((v, i) => Math.abs(v - expectBg[i]) > 3));
  check(`the frame area is the Kiro Crew theme background rgb(${expectBg.join(', ')}) while loading`, loading.length > 0 && off.length === 0,
    off.length ? `${off.length} samples off, e.g. rgb(${off[0].centre.join(', ')})` : `centre rgb(${loading[0] ? loading[0].centre.join(', ') : '?'})`);
  check('the frame host tells the browser the theme kind (color-scheme dark) so a cross-origin page never gets an opaque canvas',
    loading.length > 0 && loading.every((s) => s.scheme === 'dark'), JSON.stringify([...new Set(loading.map((s) => s.scheme))]));
  const mid = loading[Math.floor(loading.length / 2)];
  if (mid) {
    const shot = path.join(shotDir, 'load-dark.png');
    fs.writeFileSync(shot, mid.png);
    check('dark screenshot of the pane mid-load saved (.cache/smoke/load-dark.png)', fs.existsSync(shot), shot);
  }
}
