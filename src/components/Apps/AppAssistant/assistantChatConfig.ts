import type { ChatConfig, CivitaiChat } from '@civitai/components-chat/civitai-chat';

/** Each step is one paid model request; the per-reply tool-call limit in `assistantGate` pauses far sooner. */
export const APP_ASSISTANT_MAX_STEPS = 1000;

/** Earlier conversation a reply sends: one turn of reading source files is about 10k tokens. */
export const APP_ASSISTANT_CONTEXT_BUDGET_TOKENS = 64_000;

/**
 * Orchestration tools the assistant is not offered. The generation tools (and the panels, which run
 * through `run_step`) spend Buzz and are never how an app gets built: the app generates through its own
 * SDK in the preview. `transcribe_audio` charges per call and has no use here; the microphone button
 * transcribes on its own, so voice input still works.
 */
export const APP_ASSISTANT_EXCLUDED_TOOLS = [
  'run_step',
  'run_workflow',
  'transcribe_audio',
] as const;

export const APP_ASSISTANT_CHAT_CONFIG = {
  maxSteps: APP_ASSISTANT_MAX_STEPS,
  contextBudgetTokens: APP_ASSISTANT_CONTEXT_BUDGET_TOKENS,
} satisfies Partial<ChatConfig>;

export const APP_ASSISTANT_MCP: CivitaiChat['mcp'] = {
  orchestration: { exclude: APP_ASSISTANT_EXCLUDED_TOOLS },
};
