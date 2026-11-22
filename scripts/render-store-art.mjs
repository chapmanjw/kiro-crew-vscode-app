#!/usr/bin/env node
// Build the App Store artwork.
//
//   node scripts/render-store-art.mjs
//
// Outputs (plain SVG, no scripts, no external references):
//   assets/store-hero.svg         1200x675 (16:9) Browse hero
//   assets/store-hero-detail.svg  1200x288 (25:6) detail-page banner
//
// Kiro Crew shows the hero with `object-cover` in a 16:9 box and the detail banner in
// a 25:6 box capped at 288px tall, so both are drawn at exactly those ratios and the
// detail banner keeps everything that matters inside y 54..234 (a viewport up to about
// 1920px wide trims the top and bottom evenly, never the sides).
//
// The VS Code mark is the silhouette and panel path pair in ui/icon.svg. The Kiro Crew mark is
// the app icon artwork from the Kiro Crew source, site/public/kirocrew-logo.svg,
// vendored unchanged in assets/kirocrew-logo.svg (only its drop-shadow filters, which
// are not needed on a flat tile, are left out when it is placed).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPaths } from './lib/icon-marks.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { silhouette: vscShape, panel: vscBar } = extractPaths(read('ui/icon.svg'));

const kc = read('assets/kirocrew-logo.svg');
const KC_BOX = [37.4, 29.85, 206.59]; // x, y, size of the squircle in the source
const kcGradient = /<linearGradient id="linear-gradient"([^>]*)>([\s\S]*?)<\/linearGradient>/.exec(kc);
const kcRadius = /class="cls-1" x="37.4" y="29.85" width="206.59" height="206.59" rx="([\d.]+)"/.exec(kc)[1];
const kcBody = /<g class="cls-8">([\s\S]*)<\/g>\s*<\/g>\s*<\/g>\s*<\/svg>/.exec(kc)[1];
const kcFlatten = (s) => s
  .replace(/ class="cls-[234]"/g, '')
  .replace(/ class="cls-6"/g, ' fill="#fff"');
if (!vscShape || !vscBar || !kcGradient || !kcBody) throw new Error('source marks not found');

let uid = 0;
/** VS Code mark, `size` px square, top-left at (x, y). */
function vsMark(x, y, size) {
  const id = `vs${uid++}`;
  return `<g transform="translate(${x} ${y}) scale(${size / 256})"><clipPath id="${id}"><path clip-rule="evenodd" d="${vscShape}"/></clipPath><path fill="#007ACC" fill-rule="evenodd" d="${vscShape}"/><path fill="#1F9CF0" clip-path="url(#${id})" d="${vscBar}"/></g>`;
}
/** Kiro Crew app icon, `size` px square, top-left at (x, y). */
function kcMark(x, y, size) {
  const id = uid++;
  const s = size / KC_BOX[2];
  const [bx, by, bs] = KC_BOX;
  return `<g transform="translate(${x - bx * s} ${y - by * s}) scale(${s})"><defs><linearGradient id="kg${id}"${kcGradient[1].replace(/ id="[^"]*"/, '')}>${kcGradient[2]}</linearGradient><clipPath id="kc${id}"><rect x="${bx}" y="${by}" width="${bs}" height="${bs}" rx="${kcRadius}"/></clipPath></defs><rect x="${bx}" y="${by}" width="${bs}" height="${bs}" rx="${kcRadius}" fill="#844cf5"/><rect x="${bx}" y="${by}" width="${bs}" height="${bs}" rx="53.2" fill="url(#kg${id})" transform="translate(281.39 266.29) rotate(-180)"/><g clip-path="url(#kc${id})">${kcFlatten(kcBody)}</g></g>`;
}

const FONT = "font-family=\"'Segoe UI',system-ui,-apple-system,Helvetica,Arial,sans-serif\"";
const bar = (x, y, w, c, h = 8) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${c}"/>`;

// Kiro Crew's own dark theme (website/src/styles/theme-palettes.css, [data-theme="kiro-dark"]).
const KC = { bg: '#19161d', rail: '#1c1922', card: '#211d25', hover: '#28242e', border: '#352f3d', text: '#dcdadf', muted: '#938f9b', dim: '#5e5966', accent: '#8e48ff', accentSubtle: 'rgba(178,127,255,.16)', aim: '#c19aff' };
// VS Code's default Dark+ colours.
const VS = { title: '#3c3c3c', activity: '#333333', side: '#252526', editor: '#1e1e1e', tab: '#2d2d2d', status: '#007acc', line: '#6e7681', kw: '#569cd6', str: '#ce9178', type: '#4ec9b0', fn: '#dcdcaa', ctl: '#c586c0', id: '#9cdcfe', cmt: '#6a9955' };
const SYN = [VS.kw, VS.str, VS.type, VS.fn, VS.ctl, VS.id, VS.line];

/** Code lines for the editor area at (x, y), as many rows as fit in h, no wider than w. */
function codeLines(x, y, w, h, u, rowH) {
  const rows = [[[70, VS.ctl], [90, VS.id]], [[40, VS.kw], [110, VS.line]], [[28, 0], [60, VS.type], [80, VS.line]], [[28, 0], [90, VS.fn], [50, VS.str]], [[56, 0], [70, VS.id]], [[28, 0], [44, VS.cmt]], [[40, VS.kw], [90, VS.line]], [[70, VS.ctl], [60, VS.type]]];
  let out = '';
  for (let i = 0; (i + 1) * rowH <= h && i < rows.length; i++) {
    let cx = x;
    for (const [len, c] of rows[i]) {
      const lw = len * u;
      if (c && cx - x + lw <= w) out += bar(cx, y + i * rowH, lw, c, 7 * u);
      cx += lw + 8 * u;
    }
  }
  return out;
}

/**
 * A VS Code window (title bar, activity bar, side bar, tabs, editor, status bar) in the box
 * (x, y, w, h). `r` rounds the corners (0 = square, for a bleed tile). The real VS Code mark
 * sits in the editor, `big` px square. `centre` puts it mid-editor (a narrow tile) rather than
 * on the right with the code on the left.
 */
function vsWindow(x, y, w, h, u, { r = 0, big, centre = false }) {
  const tb = 22 * u; const sb = 16 * u; const ab = 30 * u; const sw = Math.min(88 * u, w * 0.2);
  const ex = x + ab + sw; const ew = w - ab - sw; const ty = y + tb; const tabH = 22 * u;
  const edTop = ty + tabH; const edH = h - tb - sb - tabH;
  const id = `vw${uid++}`;
  let out = `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/></clipPath><g clip-path="url(#${id})">`;
  out += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${VS.editor}"/>`;
  out += `<rect x="${x}" y="${y}" width="${w}" height="${tb}" fill="${VS.title}"/>`;
  out += vsMark(x + 8 * u, y + 4 * u, 14 * u) + bar(x + 30 * u, y + 8 * u, 36 * u, '#9d9d9d', 6 * u) + bar(x + 74 * u, y + 8 * u, 30 * u, '#7d7d7d', 6 * u) + bar(x + 112 * u, y + 8 * u, 30 * u, '#7d7d7d', 6 * u);
  out += `<rect x="${x}" y="${ty}" width="${ab}" height="${h - tb - sb}" fill="${VS.activity}"/>`;
  for (let i = 0; i < 4; i++) out += `<rect x="${x + 8 * u}" y="${ty + (10 + i * 28) * u}" width="${14 * u}" height="${14 * u}" rx="${3 * u}" fill="${i === 0 ? '#d7d7d7' : '#858585'}"/>`;
  out += `<rect x="${x + ab}" y="${ty}" width="${sw}" height="${h - tb - sb}" fill="${VS.side}"/>`;
  for (let i = 0; i < 7 && (14 + i * 20) * u + 10 * u < h - tb - sb; i++) out += bar(x + ab + (10 + (i % 3 === 1 ? 10 : 0)) * u, ty + (14 + i * 20) * u, (sw / u - 30 - (i % 2) * 14) * u, i === 2 ? '#c5c5c5' : '#7d7d7d', 7 * u);
  out += `<rect x="${ex}" y="${ty}" width="${ew}" height="${tabH}" fill="${VS.tab}"/><rect x="${ex}" y="${ty}" width="${Math.min(110 * u, ew * 0.5)}" height="${tabH}" fill="${VS.editor}"/>${bar(ex + 12 * u, ty + 8 * u, Math.min(70 * u, ew * 0.3), '#c5c5c5', 6 * u)}`;
  const rowH = 17 * u;
  if (centre) {
    out += codeLines(ex + 14 * u, edTop + 14 * u, ew - 28 * u, 56 * u, u, rowH);
    out += codeLines(ex + 14 * u, y + h - sb - 14 * u - 56 * u, ew - 28 * u, 56 * u, u, rowH);
    out += vsMark(ex + (ew - big) / 2, edTop + (edH - big) / 2, big);
  } else {
    const mx = ex + ew - big - 22 * u;
    out += codeLines(ex + 16 * u, edTop + 16 * u, mx - ex - 32 * u, edH - 24 * u, u, rowH);
    out += vsMark(mx, edTop + (edH - big) / 2, big);
  }
  out += `<rect x="${x}" y="${y + h - sb}" width="${w}" height="${sb}" fill="${VS.status}"/>${bar(x + 10 * u, y + h - sb + 5 * u, 34 * u, '#ffffffcc', 6 * u)}${bar(x + w - 60 * u, y + h - sb + 5 * u, 46 * u, '#ffffffcc', 6 * u)}`;
  return out + '</g>';
}

/**
 * A Kiro Crew window (title bar, left rail with the Code row selected, content area) holding a
 * VS Code window in its content area, drawn in a W x H box at the origin. `bleed` drops the
 * outer rounding, border and content padding so the art can fill a tile edge to edge.
 */
function crewWindow(W, H, { bleed = false, railW = 140, kcBig = 0, vsBig = 0, centre = false, titleH = 34 } = {}) {
  const u = H / 400; const th = titleH * u; const rw = railW * u; const r = bleed ? 0 : 16 * u; const pad = bleed ? 0 : 14 * u;
  const id = `cw${uid++}`;
  let out = `<clipPath id="${id}"><rect width="${W}" height="${H}" rx="${r}"/></clipPath><g clip-path="url(#${id})">`;
  out += `<rect width="${W}" height="${H}" fill="${KC.bg}"/>`;
  out += `<rect width="${W}" height="${th}" fill="${KC.rail}"/><rect y="${th - u}" width="${W}" height="${Math.max(1, u)}" fill="${KC.border}"/>`;
  if (!bleed) out += [22, 40, 58].map((cx, i) => `<circle cx="${cx * u}" cy="${th / 2}" r="${5 * u}" fill="${['#ff5f57', '#febc2e', '#28c840'][i]}"/>`).join('');
  if (!kcBig) out += kcMark(84 * u, th / 2 - 10 * u, 20 * u) + bar(112 * u, th / 2 - 4 * u, 56 * u, KC.muted, 8 * u);
  out += `<rect y="${th}" width="${rw}" height="${H - th}" fill="${KC.rail}"/><rect x="${rw - Math.max(1, u)}" y="${th}" width="${Math.max(1, u)}" height="${H - th}" fill="${KC.border}"/>`;
  let ry = th + 14 * u;
  if (kcBig) { out += kcMark((rw - kcBig) / 2, ry, kcBig); ry += kcBig + 22 * u; }
  const rowH = 30 * u; const gap = 8 * u;
  for (let i = 0; i < 6 && ry + rowH <= H - (bleed ? 56 : 8) * u; i++, ry += rowH + gap) {
    const sel = i === 2;
    if (sel) out += `<rect x="${10 * u}" y="${ry}" width="${rw - 20 * u}" height="${rowH}" rx="${8 * u}" fill="${KC.accentSubtle}"/>`;
    if (sel) out += vsMark(18 * u, ry + 6 * u, 18 * u); else out += `<rect x="${19 * u}" y="${ry + 8 * u}" width="${16 * u}" height="${14 * u}" rx="${4 * u}" fill="${KC.dim}"/>`;
    out += bar(46 * u, ry + rowH / 2 - 4 * u, (sel ? 54 : 40 + (i % 3) * 14) * u, sel ? KC.aim : KC.dim, 8 * u);
  }
  out += vsWindow(rw + pad, th + pad, W - rw - 2 * pad, H - th - 2 * pad, u, { r: bleed ? 0 : 9 * u, big: vsBig || 128 * u, centre });
  out += '</g>';
  if (!bleed) out += `<rect x="${u}" y="${u}" width="${W - 2 * u}" height="${H - 2 * u}" rx="${r}" fill="none" stroke="${KC.border}" stroke-width="${2 * u}"/>`;
  return out;
}

const backdrop = (w, h) => `<defs><radialGradient id="glowL" cx="0.1" cy="0.15" r="0.7"><stop offset="0" stop-color="#8e48ff" stop-opacity="0.34"/><stop offset="1" stop-color="#8e48ff" stop-opacity="0"/></radialGradient><radialGradient id="glowR" cx="0.95" cy="1" r="0.7"><stop offset="0" stop-color="#007ACC" stop-opacity="0.26"/><stop offset="1" stop-color="#007ACC" stop-opacity="0"/></radialGradient></defs>
<g id="bg"><rect width="${w}" height="${h}" fill="#141119"/><rect width="${w}" height="${h}" fill="url(#glowL)"/><rect width="${w}" height="${h}" fill="url(#glowR)"/></g>`;
const plus = (x, y, s) => `<path d="M${x - s / 2} ${y}h${s}M${x} ${y - s / 2}v${s}" stroke="#938f9b" stroke-width="${Math.max(2.5, s / 6)}" stroke-linecap="round"/>`;

const HEAD = 'Your editor,';
const HEAD2 = 'alongside your crew';
const SUB = 'Open any project in Visual Studio Code without leaving Kiro Crew.';
const TITLE = 'Your editor, alongside your crew';

function hero() {
  const k = 500 / 640;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"><title>${TITLE}</title>
${backdrop(1200, 675)}
<g id="logos">${kcMark(80, 150, 76)}${plus(188, 188, 28)}${vsMark(220, 150, 76)}</g>
<text id="head1" x="80" y="300" ${FONT} font-size="52" font-weight="700" fill="#F4F4FB">${HEAD}</text>
<text id="head2" x="80" y="362" ${FONT} font-size="52" font-weight="700" fill="#F4F4FB">${HEAD2}</text>
<text id="sub1" x="82" y="416" ${FONT} font-size="24" fill="#B4B4CE">Open any project in Visual Studio Code</text>
<text id="sub2" x="82" y="448" ${FONT} font-size="24" fill="#B4B4CE">without leaving Kiro Crew.</text>
<g id="art" transform="translate(620 150) scale(${k})">${crewWindow(640, 480)}</g>
</svg>
`;
}

// Everything sits in y 84..198, a band that stays visible at any width up to 2400px
// (the 288px-tall box shows 345600/width viewBox units, centred), on one horizontal row.
function detail() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="288" viewBox="0 0 1200 288"><title>${TITLE}</title>
${backdrop(1200, 288)}
<g id="logos">${kcMark(56, 84, 34)}${plus(108, 101, 12)}${vsMark(126, 84, 34)}</g>
<text id="head1" x="56" y="160" ${FONT} font-size="38" font-weight="700" fill="#F4F4FB">${TITLE}</text>
<text id="sub1" x="57" y="191" ${FONT} font-size="16" fill="#B4B4CE">${SUB}</text>
<g id="art" transform="translate(724 84)">${crewWindow(420, 114, { railW: 330, vsBig: 60, titleH: 30 })}</g>
</svg>
`;
}

fs.writeFileSync(path.join(ROOT, 'assets/store-hero.svg'), hero());
fs.writeFileSync(path.join(ROOT, 'assets/store-hero-detail.svg'), detail());
console.log('wrote assets/store-hero.svg and store-hero-detail.svg');
