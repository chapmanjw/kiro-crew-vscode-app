// Request parsing for the routes that drive VS Code's "Kiro Crew" view and
// the secret-storage probe (backend/launcher.mjs, crewView and secretProbe).

/** Where the view can be moved: VS Code view container ids (vscode.moveViews). */
export const CREW_VIEW_HOMES = Object.freeze({
  auxiliarybar: 'workbench.view.extension.kiroCrew',
  sidebar: 'workbench.view.explorer',
  panel: 'workbench.panel.output',
});

/** `{action: "reveal"}` or `{action: "move", to: "auxiliarybar"|"sidebar"|"panel"}`. */
export function parseCrewViewRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  if (body.action === 'reveal') return { command: { kind: 'revealCrewView' } };
  if (body.action === 'move') {
    if (!Object.hasOwn(CREW_VIEW_HOMES, body.to)) return { error: `to must be one of ${Object.keys(CREW_VIEW_HOMES).join(', ')}` };
    return { command: { kind: 'moveCrewView', to: body.to, container: CREW_VIEW_HOMES[body.to] } };
  }
  return { error: 'action must be "reveal" or "move"' };
}

/** `{op: "set", value}` (1-200 printable characters) or `{op: "get"}`. */
export function parseSecretProbe(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  if (body.op === 'get') return { command: { kind: 'secretProbe', op: 'get' } };
  if (body.op === 'set') {
    const v = body.value;
    if (typeof v !== 'string' || v.length < 1 || v.length > 200 || /[^\x20-\x7e]/.test(v)) return { error: 'value must be 1-200 printable ASCII characters' };
    return { command: { kind: 'secretProbe', op: 'set', value: v } };
  }
  return { error: 'op must be "set" or "get"' };
}
