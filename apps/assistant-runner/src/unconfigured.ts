import type { Authenticator, ConversationStore, ModelProvider, ToolProvider } from './interfaces';

// TODO: replace each of these with the real implementation: the viewer's civitai token
// verified by the auth hub, orchestration as the model with a token minted per request, the
// sandbox MCP tools, and the orchestrator-backed conversation head.

/** Refuses every request. The default, so a runner with no authenticator configured serves nobody. */
export const refuseAll: Authenticator = {
  authenticate: async () => ({
    ok: false,
    status: 401,
    message: 'Sign-in is not available on this runner yet.',
  }),
};

function unconfigured(what: string): never {
  throw new Error(`assistant-runner: no ${what} is configured`);
}

export const unconfiguredModel: ModelProvider = {
  languageModel: () => unconfigured('model provider'),
};

export const unconfiguredTools: ToolProvider = {
  open: async () => unconfigured('tool provider'),
};

export const unconfiguredStore: ConversationStore = {
  load: async () => unconfigured('conversation store'),
  update: async () => unconfigured('conversation store'),
};
