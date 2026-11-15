// Checks on the icon files app.json names, shared by the unit tests and the
// smoke test (which runs them against the staged copy).
import fs from 'node:fs';
import path from 'node:path';

/**
 * Every icon file the manifest names, with the path Kiro Crew resolves it
 * against: top-level iconPath/iconPathDark from the app root, page
 * iconUrl/iconInactiveUrl from ui/.
 */
export function manifestIconFiles(appRoot) {
  const m = JSON.parse(fs.readFileSync(path.join(appRoot, 'app.json'), 'utf8'));
  const out = [];
  for (const field of ['iconPath', 'iconPathDark']) {
    if (m[field]) out.push({ field, file: path.join(appRoot, m[field]) });
  }
  for (const [i, page] of (m.ui?.pages || []).entries()) {
    for (const field of ['iconUrl', 'iconInactiveUrl']) {
      if (page[field]) out.push({ field: `ui.pages[${i}].${field}`, file: path.join(appRoot, 'ui', page[field]) });
    }
  }
  return out;
}

/**
 * Problems with one SVG's text, or [] when it is fine: an <svg> root whose
 * elements nest and close correctly, and nothing that runs script or loads
 * from elsewhere. A full XML parse happens in the smoke test (DOMParser).
 */
export function svgProblems(text) {
  const problems = [];
  const body = text.replace(/^﻿/, '').replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!/^<svg[\s>]/.test(body)) problems.push('root element is not <svg>');
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(body)) problems.push('no SVG namespace');
  if (/<script|<foreignObject|\son[a-z]+\s*=|javascript:|<image|href="(?!#)/i.test(body)) problems.push('script, event handler or external reference');
  // Tag balance (CDATA-free <style> is the only text content these files have).
  const stack = [];
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g)) {
    const [, close, name, self] = m;
    if (self) continue;
    if (!close) stack.push(name);
    else if (stack.pop() !== name) {
      problems.push(`</${name}> does not close the open element`);
      break;
    }
  }
  if (stack.length) problems.push(`unclosed <${stack.join('>, <')}>`);
  return problems;
}

/** True for a PNG signature. */
export function isPng(buf) {
  return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}
