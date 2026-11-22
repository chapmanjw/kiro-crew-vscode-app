// "Open in Code" chip in the chat composer (contributes.sessionControls).
//
// Kiro Crew renders an app's session controls in the composer shelf, before
// the agent chip ("Ultra Mode") and the project chip, and mounts this module in
// a small popover when the chip is clicked, handing it the chat's identity:
// `session.sessionKey` is the chat and `session.cwd` its project folder. The
// control navigates straight to the VS Code page, which opens a tab for this
// chat on that folder, or brings back the tab it opened for it before; the
// tab's Kiro Crew view shows this chat. The host's navigate closes the popover
// first, so to the user the chip acts as a button.
import React, { useEffect, useRef } from 'react';
import { useNavigate } from '@kirocrew/app-sdk';
import { appPageUrl } from './vscode-pane-core-0.7.0.mjs';

const h = React.createElement;

const box = {
  padding: '10px 12px', fontSize: 12, lineHeight: 1.45,
  color: 'var(--text,#e4e4e7)', fontFamily: 'var(--font-body,system-ui,sans-serif)',
};
const btn = {
  font: 'inherit', fontSize: 12, height: 26, padding: '0 10px', marginTop: 8, cursor: 'pointer',
  borderRadius: 'var(--radius-sm,6px)', border: '1px solid transparent',
  background: 'var(--accent,#00d492)', color: 'var(--accent-fg,#000)',
};

export default function OpenInVsCodeControl({ session, onClose }) {
  const navigate = useNavigate();
  const cwd = (session && typeof session.cwd === 'string' && session.cwd.trim()) || '';
  const key = (session && typeof session.sessionKey === 'string' && session.sessionKey.trim()) || '';
  const went = useRef(false);

  useEffect(() => {
    if (!cwd || went.current) return;
    went.current = true;
    navigate(appPageUrl(cwd, key));
  }, [cwd, key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (cwd) {
    return h('div', { style: box, role: 'status', 'data-testid': 'vscode-pane-session-control' }, 'Opening VS Code on ', h('code', null, cwd), '...');
  }
  // A chat with no project folder: say so, and still offer the page.
  return h('div', { style: box, 'data-testid': 'vscode-pane-session-control' },
    h('div', null, key
      ? 'This chat has no project folder yet. VS Code opens on its default folder, with this chat in its Kiro Crew tab.'
      : 'This chat has no project folder yet. VS Code opens on its default folder.'),
    h('button', {
      type: 'button', style: btn,
      onClick: () => {
        navigate(appPageUrl('', key));
        if (typeof onClose === 'function') onClose();
      },
    }, 'Open VS Code'));
}
