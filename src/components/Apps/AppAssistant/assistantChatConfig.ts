import type { ChatConfig, CivitaiChat } from '@civitai/components-chat/civitai-chat';

/**
 * Each step is one paid model request. The tool-call limit in `assistantGate` ends a reply first when its
 * calls reach the page's gate. A call to a tool that does not exist never does, so a reply making only
 * those runs to this.
 */
export const APP_ASSISTANT_MAX_STEPS = 1000;

export const APP_ASSISTANT_CONTEXT_BUDGET_TOKENS = 64_000;

/**
 * Orchestration tools that charge per call and that building an app does not need: generation (and the
 * panels, via run_step) happens in the app through its own SDK, and the docs are reached by URL with
 * fetch_page. The microphone button transcribes on its own, so voice input still works.
 */
export const APP_ASSISTANT_EXCLUDED_TOOLS = [
  'run_step',
  'run_workflow',
  'transcribe_audio',
  'caption_media',
  'web_search',
] as const;

export const APP_ASSISTANT_CHAT_CONFIG = {
  maxSteps: APP_ASSISTANT_MAX_STEPS,
  contextBudgetTokens: APP_ASSISTANT_CONTEXT_BUDGET_TOKENS,
} satisfies Partial<ChatConfig>;

export const APP_ASSISTANT_MCP: CivitaiChat['mcp'] = {
  orchestration: { exclude: APP_ASSISTANT_EXCLUDED_TOOLS },
};
