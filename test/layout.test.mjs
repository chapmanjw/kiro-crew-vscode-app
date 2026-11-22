// The card and toolbar geometry that lines the pane up with Kiro Crew's nav
// card in both nav modes. Numbers are Kiro Crew's own (0.14 source and the
// shipped 0.13.0-rc.1 bundle, which has the same classes):
//   nav card   `mx-2 mt-0 mb-2 rounded-xl border` (shell/nav/navRail.tsx:457)
//   tracks     74px collapsed, 236px expanded (hooks/useRailWidth.ts:20-21)
//   header     `px-2 pt-2 gap-0.5`, brand row `mb-1.5` with a w-7 h-7 logo when
//              expanded, then `h-px` hairline (navRail.tsx:149-154, railChrome.tsx)
//   baseline   headers centred 23px below the panel's outer top (listShell.ts)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_MARGIN, BAR_HEIGHT } from '../ui/vscode-pane-core-0.7.0.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = fs.readFileSync(path.join(ROOT, 'ui', 'vscode-pane-0.7.0.mjs'), 'utf8');

const NAV = { border: 1, padTop: 8, logoExpanded: 28, brandMarginBottom: 6, gap: 2, marginX: 8, marginBottom: 8, radius: 16 };
const hairlineTop = NAV.border + NAV.padTop + NAV.logoExpanded + NAV.brandMarginBottom + NAV.gap;

test('card margins line up with the nav card in both modes (track width does not enter)', () => {
  for (const track of [74, 236]) {
    const navRight = track - NAV.marginX; // nav card's right edge inside its track
    const cardLeft = track + CARD_MARGIN.left; // <main> starts at the track's end
    assert.equal(cardLeft - navRight, 8, `gap to the nav card at a ${track}px track`);
  }
  assert.equal(CARD_MARGIN.top, 0, 'top level with the nav card (mt-0)');
  assert.equal(CARD_MARGIN.bottom, NAV.marginBottom, 'bottom level with the nav card (mb-2)');
  assert.equal(CARD_MARGIN.right, NAV.marginX, 'right inset mirrors the nav card left inset (mx-2)');
});

test('toolbar bottom border sits on the expanded sidebar hairline; controls centre on the 23px line', () => {
  assert.equal(hairlineTop, 45);
  const barLine = 1 + BAR_HEIGHT - 1; // card top border, then the strip; its last px is the border
  assert.equal(barLine, hairlineTop);
  assert.equal(1 + (BAR_HEIGHT - 1) / 2, 23);
  assert.match(page, /\.vscp-bar\{[^}]*height:\$\{BAR_HEIGHT\}px;min-height:\$\{BAR_HEIGHT\}px;[^}]*border-bottom:1px solid/);
  assert.match(page, /border:1px solid var\(--vscp-border\);border-radius:var\(--radius-xl,\$\{RADIUS_FALLBACK\}px\)/);
  assert.match(page, /const RADIUS_FALLBACK = 16;/);
});
