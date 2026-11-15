// vscode-pane UI page (plain ESM, no build step). The dashboard imports this
// module into its own React tree; 'react' and '@kirocrew/app-sdk' resolve
// through the host's import map. The file name carries the version so
// Electron's code cache cannot pin an old copy after an Update.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAppApi } from '@kirocrew/app-sdk';

const h = React.createElement;
const API = '/apps/vscode-pane/api';
const FOLDER_KEY = 'kc:vscode-pane:folder';

// useAppApi throws AppApiError on non-2xx in 0.14 and resolved null in older
// hosts; fold both into one thrown error.
async function call(promise) {
  const r = await promise;
  if (r === null || r === undefined) throw new Error('request failed');
  return r;
}

function errText(e) {
  if (!e) return '';
  const body = typeof e.body === 'string' ? e.body : '';
  try {
    const parsed = JSON.parse(body);
    if (parsed && parsed.error) return parsed.error;
  } catch {
    /* not JSON */
  }
  return e.message || String(e);
}

const S = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 'calc(100vh - 96px)', width: '100%', gap: 0 },
  bar: {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 8px',
    borderBottom: '1px solid rgba(128,128,128,0.25)', fontSize: 12,
  },
  group: { display: 'flex', alignItems: 'center', gap: 4 },
  input: {
    font: 'inherit', fontSize: 12, padding: '3px 6px', borderRadius: 4, minWidth: 0,
    border: '1px solid rgba(128,128,128,0.4)', background: 'transparent', color: 'inherit',
  },
  btn: {
    font: 'inherit', fontSize: 12, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
    border: '1px solid rgba(128,128,128,0.4)', background: 'rgba(128,128,128,0.12)', color: 'inherit',
  },
  dot: (color) => ({ width: 8, height: 8, borderRadius: 4, background: color, display: 'inline-block' }),
  muted: { opacity: 0.7 },
  frameWrap: { position: 'relative', flex: '1 1 auto', minHeight: 0 },
  frame: { position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0, background: '#1e1e1e' },
  overlay: {
    position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center',
    padding: 24, fontSize: 13,
  },
};

const STATUS_COLOR = { ready: '#2ea043', starting: '#d29922', provisioning: '#d29922', error: '#f85149', stopped: '#8b949e', idle: '#8b949e' };

function readStoredFolder() {
  try {
    return window.localStorage.getItem(FOLDER_KEY) || '';
  } catch {
    return '';
  }
}

export default function VsCodePane() {
  // The host may hand a new client object per render; read it through a ref so
  // polling effects do not restart on every render.
  const apiNow = useAppApi();
  const apiRef = useRef(apiNow);
  apiRef.current = apiNow;
  const api = {
    get: (...a) => apiRef.current.get(...a),
    post: (...a) => apiRef.current.post(...a),
  };
  const [folder, setFolder] = useState(readStoredFolder);
  const [folderInput, setFolderInput] = useState(folder);
  const [session, setSession] = useState(null);
  const [sessionError, setSessionError] = useState('');
  const [recent, setRecent] = useState([]);
  const [frameNonce, setFrameNonce] = useState(0);
  const [openPath, setOpenPath] = useState('');
  const [openLine, setOpenLine] = useState('');
  const [openResult, setOpenResult] = useState('');
  const [editor, setEditor] = useState(null);
  const frameUrl = useRef(null);

  const ready = !!(session && session.ready && session.url);

  const loadSession = useCallback(async () => {
    try {
      const q = folder ? `?folder=${encodeURIComponent(folder)}` : '';
      const s = await call(api.get(`${API}/session${q}`));
      setSession(s);
      setSessionError('');
      if (!folder && s.folder) setFolderInput((cur) => cur || s.folder);
    } catch (e) {
      setSessionError(errText(e));
    }
  }, [folder]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the session fast while VS Code provisions, slowly once it is up.
  useEffect(() => {
    let alive = true;
    let timer;
    const tick = async () => {
      await loadSession();
      if (alive) timer = setTimeout(tick, ready ? 10000 : 1500);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [loadSession, ready]);

  // VS Code -> Kiro Crew: the active editor as the bridge extension reports it.
  useEffect(() => {
    if (!ready) return undefined;
    let alive = true;
    let timer;
    const tick = async () => {
      try {
        const st = await call(api.get(`${API}/state`));
        if (alive) setEditor(st);
      } catch {
        /* keep the last value */
      }
      if (alive) timer = setTimeout(tick, 2000);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    call(api.get('/api/recent-projects'))
      .then((r) => alive && Array.isArray(r.dirs) && setRecent(r.dirs.slice(0, 20)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the iframe on one URL per folder/reload so polling never reloads it.
  if (ready) {
    const key = `${session.url}#${frameNonce}`;
    if (!frameUrl.current || frameUrl.current.key !== key) {
      frameUrl.current = { key, url: session.url };
    }
  }

  const applyFolder = (value) => {
    const v = (value || '').trim();
    setFolder(v);
    setFolderInput(v);
    try {
      if (v) window.localStorage.setItem(FOLDER_KEY, v);
      else window.localStorage.removeItem(FOLDER_KEY);
    } catch {
      /* storage blocked */
    }
  };

  const doOpen = async (ev) => {
    ev.preventDefault();
    if (!openPath.trim()) return;
    setOpenResult('Opening...');
    try {
      const body = { path: openPath.trim() };
      if (openLine.trim()) body.line = Number(openLine.trim());
      const r = await call(api.post(`${API}/open`, body));
      setOpenResult(
        r.ok ? 'Opened in VS Code' : r.timeout ? (r.delivered ? 'Sent; VS Code did not confirm' : 'Queued; VS Code bridge is not connected yet') : `Failed: ${r.error || 'unknown error'}`,
      );
    } catch (e) {
      setOpenResult(`Failed: ${errText(e)}`);
    }
  };

  const doRestart = async () => {
    try {
      await call(api.post(`${API}/restart`, {}));
      setSession((s) => (s ? { ...s, ready: false, status: 'starting', message: 'Restarting VS Code server' } : s));
    } catch (e) {
      setSessionError(errText(e));
    }
  };

  const status = session ? session.status : sessionError ? 'error' : 'idle';
  const statusText = sessionError
    ? `Backend unreachable: ${sessionError}`
    : session
      ? session.error
        ? `${session.message}: ${session.error}`
        : session.message || session.status
      : 'Connecting to the vscode-pane backend...';

  const active = editor && editor.activeEditor;
  const activeText = active
    ? `${active.path}${active.selection ? `:${active.selection.startLine}:${active.selection.startColumn}` : ''}`
    : 'no file';

  const toolbar = h(
    'div',
    { style: S.bar, role: 'toolbar', 'aria-label': 'VS Code controls' },
    h('span', { style: S.group, title: statusText, role: 'status' },
      h('span', { style: S.dot(STATUS_COLOR[status] || '#8b949e') }),
      h('span', null, ready ? 'VS Code' : status)),
    h('form', {
      style: { ...S.group, flex: '1 1 260px' },
      onSubmit: (e) => { e.preventDefault(); applyFolder(folderInput); },
    },
      h('label', { htmlFor: 'vscp-folder', style: S.muted }, 'Folder'),
      h('input', {
        id: 'vscp-folder', style: { ...S.input, flex: '1 1 auto' }, list: 'vscp-recent', value: folderInput,
        placeholder: session ? session.defaultFolder || '' : '', onChange: (e) => setFolderInput(e.target.value),
        spellCheck: false,
      }),
      h('datalist', { id: 'vscp-recent' }, recent.map((d) => h('option', { key: d, value: d }))),
      h('button', { type: 'submit', style: S.btn }, 'Open folder')),
    h('button', { type: 'button', style: S.btn, onClick: () => setFrameNonce((n) => n + 1), title: 'Reload the VS Code view' }, 'Reload'),
    h('button', { type: 'button', style: S.btn, onClick: doRestart, title: 'Restart the VS Code server process' }, 'Restart server'),
    h('form', { style: { ...S.group, flex: '1 1 260px' }, onSubmit: doOpen },
      h('label', { htmlFor: 'vscp-open', style: S.muted }, 'Open file'),
      h('input', {
        id: 'vscp-open', style: { ...S.input, flex: '1 1 auto' }, value: openPath, placeholder: 'C:\\path\\to\\file',
        onChange: (e) => setOpenPath(e.target.value), spellCheck: false,
      }),
      h('input', {
        style: { ...S.input, width: 52 }, value: openLine, placeholder: 'line', inputMode: 'numeric', 'aria-label': 'Line',
        onChange: (e) => setOpenLine(e.target.value.replace(/[^0-9]/g, '')),
      }),
      h('button', { type: 'submit', style: S.btn }, 'Open'),
      openResult ? h('span', { style: S.muted, role: 'status' }, openResult) : null),
    h('span', { style: { ...S.group, ...S.muted }, title: 'Active file reported by VS Code' },
      h('span', { style: S.dot(editor && editor.connected ? '#2ea043' : '#8b949e') }),
      h('span', null, `Active: ${activeText}`)),
  );

  let body;
  if (ready && frameUrl.current) {
    body = h('iframe', {
      key: frameUrl.current.key,
      src: frameUrl.current.url,
      title: 'VS Code',
      style: S.frame,
      allow: 'clipboard-read; clipboard-write',
    });
  } else {
    const failed = status === 'error';
    body = h('div', { style: S.overlay },
      h('div', null,
        h('div', { style: { fontSize: 15, marginBottom: 8 } }, failed ? 'VS Code could not start' : 'Starting VS Code...'),
        h('div', { style: S.muted }, statusText),
        failed ? h('button', { type: 'button', style: { ...S.btn, marginTop: 12 }, onClick: doRestart }, 'Try again') : null));
  }

  return h('div', { style: S.root }, toolbar, h('div', { style: S.frameWrap }, body));
}
