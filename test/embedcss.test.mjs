// The stylesheet the tunnel injects so the tunnelled /embed/chat fills the
// "Kiro Crew" webview flush (backend/lib/chipcss.mjs embedFlushCss), and its
// wiring into the launcher. The rendered geometry is checked in the smoke
// (scripts/lib/tab-checks.mjs embedEdges).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedFlushCss, tunnelCss, chipHideCss } from '../backend/lib/chipcss.mjs';
import { embedFlush } from '../scripts/lib/tab-checks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** [selector list, declarations] per rule. */
function rules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
}

/** Split a selector list on top-level commas (not inside parentheses). */
function selectors(list) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of list) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

test('the tunnel injects the chip rule and the embed flush rules, and the launcher passes them', () => {
  assert.equal(tunnelCss(), `${chipHideCss()}\n${embedFlushCss()}`);
  const launcher = fs.readFileSync(path.join(ROOT, 'backend', 'launcher.mjs'), 'utf8');
  assert.match(launcher, /css: \(\) => tunnelCss\(bootCss\(theme, vsTheme, \{ scheme: false \}\)\),/);
  assert.doesNotMatch(launcher, /css: chipHideCss\(\)/);
});

test('every flush rule is scoped to the embed shell: it never matches the full dashboard (data-testid="app-frame")', () => {
  const rs = rules(embedFlushCss());
  assert.equal(rs.length, 4);
  for (const [list] of rs) {
    for (const sel of selectors(list)) {
      assert.match(sel, /:not\(:has\(\[data-testid="app-frame"\]\)\)/, sel);
    }
  }
});

test('no :has() nests inside another :has(), which would drop the whole rule', () => {
  for (const [list] of rules(embedFlushCss())) {
    for (const sel of selectors(list)) {
      let depth = 0;
      for (let i = 0; i < sel.length; i++) {
        if (sel.startsWith(':has(', i)) {
          assert.equal(depth, 0, `nested :has() in ${sel}`);
          let d = 0;
          let j = i + 4;
          for (; j < sel.length; j++) { if (sel[j] === '(') d++; if (sel[j] === ')' && --d === 0) break; }
          assert.doesNotMatch(sel.slice(i + 5, j), /:has\(/, `nested :has() in ${sel}`);
        }
      }
    }
  }
});

test('the shell, the boxes down to the chat pane and the pane lose margin, border, radius and shadow; html, body and #root fill the frame', () => {
  const [page, shell, chain, pane] = rules(embedFlushCss());
  assert.match(page[0], /^html:not\(:has\(\[data-testid="app-frame"\]\)\):has\(#root \[data-chat-scope\]\)/);
  assert.match(page[0], /> body/);
  assert.match(page[0], /#root:not/);
  for (const d of ['margin:0 !important', 'padding:0 !important', 'border:0 !important', 'height:100% !important', 'overflow:hidden !important']) assert.ok(page[1].includes(d), d);
  for (const [sel, decl] of [shell, chain, pane]) {
    for (const d of ['margin:0 !important', 'border:0 !important', 'border-radius:0 !important', 'box-shadow:none !important']) assert.ok(decl.includes(d), `${sel}: ${d}`);
  }
  assert.match(shell[0], /> div:has\(\[data-chat-scope\]\)$/);
  assert.ok(shell[1].includes('width:100% !important') && shell[1].includes('height:100% !important'), 'the 100vw/100vh shell is sized to the frame');
  // margin:0 !important beats the pane's inline margin-left:-8px (COLLAPSED_PANE_RECLAIM_PX).
  assert.match(pane[0], /\[data-chat-scope\]:not\(\[data-chat-scope\] \[data-chat-scope\]\)$/, 'the outermost pane only, never a split-view pane inside it');
  assert.ok(!pane[1].includes('padding'), 'the pane keeps its own padding');
  assert.match(chain[0], /:not\(\[data-chat-scope\]\):not\(\[data-chat-scope\] \*\)$/, 'nothing inside the pane is flattened');
});

test('inner parts keep their own styling: the composer, its glass pane, the context shelf and the chips are never targeted', () => {
  const css = embedFlushCss();
  for (const inner of ['composer', 'input-area', 'glass', 'shelf', 'session-control-chip', 'chat-pane', 'button', 'textarea']) assert.ok(!css.includes(inner), inner);
  assert.doesNotMatch(css, /display:none/);
});

test('embedFlush accepts only a page that is flush at every edge with the composer card kept', () => {
  const ok = { gaps: { top: 0, left: 0, right: 0, bottom: 0, paneLeft: 0, paneRight: 0, paneBottom: 0 }, bad: [], overflow: { x: 0, y: 0 }, composer: { radius: 16, border: 1 } };
  assert.equal(embedFlush(ok), true);
  assert.equal(embedFlush({ ...ok, gaps: { ...ok.gaps, bottom: 8 } }), false, 'a gap at the bottom');
  assert.equal(embedFlush({ ...ok, gaps: { ...ok.gaps, paneLeft: -8 } }), false, 'the pane pulled past the left edge');
  assert.equal(embedFlush({ ...ok, bad: ['div(shell) radius 12 12 12 12'] }), false, 'a rounded outer card');
  assert.equal(embedFlush({ ...ok, overflow: { x: 0, y: 3 } }), false, 'a scrollbar');
  assert.equal(embedFlush({ ...ok, composer: { radius: 0, border: 0 } }), false, 'the composer card flattened too');
  assert.equal(embedFlush({ error: 'no embed shell or chat pane' }), false);
  assert.equal(embedFlush(null), false);
});
