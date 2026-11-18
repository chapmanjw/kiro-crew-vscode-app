// Smoke checks for where VS Code's workbench meets the pane card (0.5.2): the
// parts on the outer edge of the workbench sit at 0 px from the frame edges
// and from the status bar, with no rounded outer corner, and no second line
// (a part's own border or hairline) runs just inside the card's border.
import fs from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';

/**
 * Run inside the workbench document. Each visible part's box, corner radii,
 * visible border widths and margins; the outer edges of the part cluster
 * against the frame and the status bar.
 */
export function workbenchEdges() {
  const de = document.documentElement;
  const vw = de.clientWidth;
  const vh = de.clientHeight;
  const wb = document.querySelector('.monaco-workbench');
  if (!wb) return { error: 'no workbench' };
  const clear = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  const n2 = (v) => Math.round((parseFloat(v) || 0) * 100) / 100;
  const parts = {};
  for (const name of ['titlebar', 'activitybar', 'sidebar', 'editor', 'panel', 'auxiliarybar', 'statusbar']) {
    const el = Array.from(wb.querySelectorAll(`.part.${name}`)).find((e) => {
      if (e.classList.contains('modal-editor-part')) return false;
      const b = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    });
    if (!el) continue;
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    const side = (k) => (cs[`border${k}Style`] === 'none' || clear(cs[`border${k}Color`]) ? 0 : n2(cs[`border${k}Width`]));
    const v = (k) => cs.getPropertyValue(k).trim();
    parts[name] = {
      l: n2(b.left), t: n2(b.top), r: n2(b.right), b: n2(b.bottom),
      radius: ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map((k) => n2(cs[`border${k}Radius`])),
      border: ['Top', 'Right', 'Bottom', 'Left'].map(side),
      margin: ['Top', 'Right', 'Bottom', 'Left'].map((k) => n2(cs[`margin${k}`])),
      outer: ['left', 'right', 'top', 'bottom'].filter((e) => el.classList.contains(`floating-part-outer-${e}`)),
      hairline: { stroke: v('--modern-ui-floating-card-stroke-color'), left: v('--modern-ui-floating-card-left-border-color'), top: v('--modern-ui-floating-card-top-border-color'), right: v('--modern-ui-floating-card-right-border-color') },
    };
  }
  const sb = parts.statusbar;
  const cluster = Object.entries(parts).filter(([k]) => k !== 'titlebar' && k !== 'statusbar');
  const minL = Math.min(...cluster.map(([, p]) => p.l));
  const maxR = Math.max(...cluster.map(([, p]) => p.r));
  const maxB = Math.max(...cluster.map(([, p]) => p.b));
  return {
    vw, vh,
    classes: { modernUI: wb.classList.contains('floating-panels'), compact: wb.classList.contains('modern-ui-compact') },
    parts,
    leftParts: cluster.filter(([, p]) => p.l - minL < 1).map(([k]) => k),
    rightParts: cluster.filter(([, p]) => maxR - p.r < 1).map(([k]) => k),
    bottomParts: cluster.filter(([, p]) => maxB - p.b < 1).map(([k]) => k),
    gaps: {
      left: minL,
      right: n2(vw - maxR),
      top: parts.titlebar ? parts.titlebar.t : null,
      auxbarToStatusbar: parts.auxiliarybar && sb ? n2(sb.t - parts.auxiliarybar.b) : null,
      clusterToStatusbar: sb ? n2(sb.t - maxB) : null,
      statusbar: sb ? [sb.l, n2(vw - sb.r), n2(vh - sb.b)] : null,
    },
  };
}

/** Problems with workbenchEdges() output; empty when the outer edges are flush. */
export function edgeProblems(e) {
  if (!e || e.error) return [e ? e.error : 'no measurement'];
  const out = [];
  const g = e.gaps;
  if (g.left !== 0) out.push(`left gap ${g.left}`);
  if (g.right !== 0) out.push(`right gap ${g.right}`);
  if (g.top !== 0) out.push(`top gap ${g.top}`);
  if (g.auxbarToStatusbar !== 0) out.push(`secondary side bar to status bar ${g.auxbarToStatusbar}`);
  if (g.clusterToStatusbar !== 0) out.push(`parts to status bar ${g.clusterToStatusbar}`);
  if (!g.statusbar || g.statusbar.some((n) => n !== 0)) out.push(`status bar edges ${JSON.stringify(g.statusbar)}`);
  const corner = { left: [0, 3], right: [1, 2], bottom: [2, 3] };
  const borderIdx = { left: 3, right: 1, bottom: 2 };
  for (const [edge, names] of [['left', e.leftParts], ['right', e.rightParts], ['bottom', e.bottomParts]]) {
    for (const n of names) {
      const p = e.parts[n];
      for (const i of corner[edge]) if (p.radius[i] !== 0) out.push(`${n} rounded ${edge} corner ${p.radius[i]}`);
      if (p.border[borderIdx[edge]] !== 0) out.push(`${n} ${edge} border ${p.border[borderIdx[edge]]}`);
    }
  }
  return out;
}

const diff = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

/**
 * Pixel check on a page screenshot: along each side of the frame, near both
 * corners, the outermost workbench line must match the line 2 px further in.
 * A part's own border or hairline right inside the card's border shows up as
 * an outermost line that differs along most of the segment.
 */
export function seamCheck(img, scale, slot) {
  const s = (n) => Math.round(n * scale);
  const L = s(slot.left);
  const T = s(slot.top);
  const R = s(slot.right) - 1;
  const B = s(slot.bottom) - 1;
  const span = (a, b) => Array.from({ length: Math.max(0, s(b) - s(a)) }, (_, i) => s(a) + i);
  const segs = {
    'left, near the bottom-left corner': span(slot.bottom - 70, slot.bottom - 24).map((y) => [[L, y], [L + s(2), y]]),
    'left, near the top-left corner': span(slot.top + 24, slot.top + 60).map((y) => [[L, y], [L + s(2), y]]),
    'right, near the bottom-right corner': span(slot.bottom - 70, slot.bottom - 24).map((y) => [[R, y], [R - s(2), y]]),
    'right, near the top-right corner': span(slot.top + 24, slot.top + 60).map((y) => [[R, y], [R - s(2), y]]),
    'bottom, near the bottom-left corner': span(slot.left + 24, slot.left + 70).map((x) => [[x, B], [x, B - s(2)]]),
    'bottom, near the bottom-right corner': span(slot.right - 70, slot.right - 24).map((x) => [[x, B], [x, B - s(2)]]),
    'top, near the top-left corner': span(slot.left + 24, slot.left + 70).map((x) => [[x, T], [x, T + s(2)]]),
    'top, near the top-right corner': span(slot.right - 70, slot.right - 24).map((x) => [[x, T], [x, T + s(2)]]),
  };
  const res = {};
  for (const [k, pairs] of Object.entries(segs)) {
    const ds = pairs.map(([a, b]) => diff(img.px(a[0], a[1]), img.px(b[0], b[1])));
    const differing = ds.filter((d) => d > 12).length;
    res[k] = { differing, of: ds.length, seam: ds.length === 0 || differing > ds.length / 2 };
  }
  return res;
}

/** The workbench edge checks, the pixel seam check and the edges-bottom screenshot. */
export async function edgeChecks({ page, frame, shotDir, check, label = '' }) {
  const pre = label ? `[${label}] ` : '';
  // `frame` may be a FrameLocator; measure in the workbench's own Frame.
  let wbFrame = typeof frame.evaluate === 'function' ? frame : null;
  for (const f of wbFrame ? [] : page.frames()) {
    if (await f.evaluate(() => !!document.querySelector('.monaco-workbench > .monaco-grid-view')).catch(() => false)) { wbFrame = f; break; }
  }
  const e = wbFrame ? await wbFrame.evaluate(workbenchEdges).catch((err) => ({ error: err.message })) : { error: 'no workbench frame' };
  const probs = edgeProblems(e);
  const summary = e.error ? e.error : JSON.stringify({ gaps: e.gaps, classes: e.classes, left: e.leftParts, right: e.rightParts, bottom: e.bottomParts });
  check(`${pre}VS Code's parts meet the pane card flush: 0 px from the frame's left, right and top edges, 0 px from the secondary side bar (and every bottom part) to the status bar, the status bar on the frame's left, right and bottom, and no rounded corner or border on an outer edge`,
    probs.length === 0, probs.length ? `${probs.join('; ')} -- ${summary}` : summary);
  const slot = await page.locator('[data-testid="vscode-pane-frame-slot"]').first().evaluate((el) => {
    const b = el.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  });
  // The frame itself: the detached wrap the page places over the slot. It runs
  // down over the card's bottom border, so it is measured here, not the slot.
  const frameBox = await page.evaluate(() => {
    const w = window.__vscodePane && window.__vscodePane.wrap;
    if (!w) return null;
    const b = w.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
  }).catch(() => null);
  const card = await page.locator('[data-testid="vscode-pane-card"]').first().evaluate((el) => {
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, radius: cs.borderBottomLeftRadius, border: cs.borderTopWidth };
  });
  const vp = page.viewportSize();
  const img = decodePng(await page.screenshot());
  const seams = seamCheck(img, img.width / vp.width, frameBox || slot);
  const bad = Object.entries(seams).filter(([, v]) => v.seam).map(([k]) => k);
  check(`${pre}no double border or 1px seam where VS Code meets the card's border, on all four sides next to all four corners`,
    bad.length === 0, `${bad.length ? `seams: ${bad.join('; ')} -- ` : ''}${JSON.stringify(seams)}`);
  // The frame sits right inside the card's 1px border on the left and right, and
  // runs down over the bottom border, so the status bar meets the card's edge.
  const box = frameBox || slot;
  const inset = [box.left - card.left, card.right - box.right, card.bottom - box.bottom].map((n) => Math.round(n * 100) / 100);
  const bw = parseFloat(card.border);
  check(`${pre}the frame sits right inside the card's ${card.border} border on the left and right, and meets the card's bottom edge (no line under the status bar), under the card's ${card.radius} radius`,
    inset.every((n, i) => n === [bw, bw, 0][i]), JSON.stringify({ inset, card, frameMeasured: !!frameBox }));
  let shot = null;
  if (shotDir && e.parts && e.parts.auxiliarybar) {
    const aux = e.parts.auxiliarybar;
    const x = Math.max(0, Math.floor(slot.left + aux.l - 24));
    const y = Math.max(0, Math.floor(slot.top + aux.b - 140));
    shot = path.join(shotDir, `edges-bottom${label ? `-${label}` : ''}.png`);
    await page.screenshot({ path: shot, clip: { x, y, width: Math.min(vp.width - x, Math.ceil(card.right + 16 - x)), height: Math.min(vp.height - y, Math.ceil(card.bottom + 12 - y)) } });
    check(`${pre}screenshot of the bottom of the Kiro Crew tab saved`, fs.existsSync(shot), shot);
  }
  return { e, seams, shot };
}
