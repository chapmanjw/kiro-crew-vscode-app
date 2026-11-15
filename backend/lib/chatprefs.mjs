// The VS Code chat settings the launcher writes into the server's Machine
// settings, and the one preference that changes them.
//
// All are supported settings of the 1.146 build; no built-in extension is
// removed and the Chat view stays enabled (chat.disableAIFeatures is never set).
//  - chat.defaultToCopilotHarness / chat.editor.preferCopilotHarness off: 1.146
//    otherwise starts new chats in the Copilot agent host, which never reaches
//    extension participants or session types.
//  - chat.mcp.autostart "never": VS Code would otherwise stop each request to
//    ask whether to start MCP servers it found in other tools' configs.
//  - chat.titleBar.signIn.enabled / chat.welcomePage.signIn.enabled off: no
//    Copilot sign-in buttons.
//  - chat.defaultModel "kiro-crew": the local harness (the 0.3.1 fallback
//    participant) starts on the bridge's Kiro Crew model.
//
// hideCopilotAgents (default true, the VS Code setting
// kiroCrew.chat.hideCopilotAgents) makes the "Kiro Crew" session type the
// default for new chats. getComputedDefaultSessionType (1.146
// contrib/chat/common/constants.ts) returns the local harness while
// chat.editor.localAgent.enabled is on, and otherwise the first visible
// non-local contributed type. Copilot CLI is never visible in the editor and
// Cloud ("copilot-cloud-agent") is visible while
// github.copilot.chat.cloudAgent.enabled holds (its contribution's `when`), so
// with all three off Kiro Crew is that first type. The local harness (Copilot
// Ask/Agent) is also hidden from the session-type picker; it comes back by
// itself when no other type is visible, for example when the session-type
// proposal is unavailable. Turned off, the keys go back to VS Code's defaults
// (local harness on, Cloud and Copilot CLI as Copilot configures them).

export const DEFAULT_CHAT_PREFS = Object.freeze({ hideCopilotAgents: true });

const BASE = Object.freeze({
  'chat.defaultToCopilotHarness': false,
  'chat.editor.preferCopilotHarness': false,
  'chat.mcp.autostart': 'never',
  'chat.titleBar.signIn.enabled': false,
  'chat.welcomePage.signIn.enabled': false,
  'chat.defaultModel': 'kiro-crew',
});

/** The settings to merge into Machine settings.json; `undefined` removes a key. */
export function chatSettings(prefs = DEFAULT_CHAT_PREFS) {
  const hide = prefs?.hideCopilotAgents !== false;
  return {
    ...BASE,
    'chat.editor.localAgent.enabled': hide ? false : true,
    'github.copilot.chat.cloudAgent.enabled': hide ? false : undefined,
    'github.copilot.chat.backgroundAgent.enabled': hide ? false : undefined,
  };
}

/** data/state/chat-prefs.json text -> prefs; anything unreadable gives the defaults. */
export function parseChatPrefs(text) {
  let v = null;
  try {
    v = JSON.parse(text || 'null');
  } catch {
    v = null;
  }
  return { hideCopilotAgents: v && typeof v.hideCopilotAgents === 'boolean' ? v.hideCopilotAgents : DEFAULT_CHAT_PREFS.hideCopilotAgents };
}
