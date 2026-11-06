import type {
  Authenticator,
  ConversationStore,
  GrantVerifier,
  ModelProvider,
  ToolProvider,
} from './interfaces';

/** Refuses every request. The default, so a runner with no authenticator configured serves nobody. */
export const refuseAll: Authenticator = {
  authenticate: async () => ({
    ok: false,
    status: 401,
    message: 'Sign-in is not available on this runner yet.',
  }),
};

/** Accepts no run grant. The default, so a runner with no key configured starts nothing. */
export const refuseGrants: GrantVerifier = {
  grant: async () => null,
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

/**
 * No tools: a reply is words only. What a configured runner uses until the sandbox tools land
 * (PR B2), so a run answers instead of failing at its first step.
 */
export const noTools: ToolProvider = {
  open: async () => ({ tools: {}, close: async () => undefined }),
};

export const unconfiguredStore: ConversationStore = {
  load: async () => unconfigured('conversation store'),
  update: async () => unconfigured('conversation store'),
};
