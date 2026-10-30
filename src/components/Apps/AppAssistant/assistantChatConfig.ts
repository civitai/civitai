import type { ChatConfig, ChatExample, CivitaiChat } from '@civitai/components-chat/civitai-chat';
import { APP_ASSISTANT_DEFAULT_MODEL, APP_ASSISTANT_MODELS } from '@civitai/app-assistant';

/**
 * Each step is one paid model request. The tool-call limit in `assistantGate` ends a reply first when its
 * calls reach the page's gate. A call the chat cannot run as written (to a tool that does not exist, or
 * with arguments that do not parse) never does, so a reply making only those runs to this.
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

/**
 * The models App Assistant's replies may use, from `@civitai/app-assistant` (the server runner refuses
 * any other). The chat's model button offers only these (`modelsOnly`), by name, and
 * keeps the pick with the chat; a chat saved with any other model replies with the default. OpenRouter
 * ids: the orchestrator routes any id that is not an AIR to OpenRouter, where no free allowance
 * applies, so every step is paid. `configureChat` is page-wide and never reset, so a chat opened
 * anywhere after App Assistant would inherit it too; today App Assistant is the only chat on the site.
 */
export const APP_ASSISTANT_CHAT_CONFIG = {
  name: 'App Assistant',
  model: APP_ASSISTANT_DEFAULT_MODEL,
  models: APP_ASSISTANT_MODELS.map(({ id, label }) => ({ id, label })),
  modelsOnly: true,
  maxSteps: APP_ASSISTANT_MAX_STEPS,
  contextBudgetTokens: APP_ASSISTANT_CONTEXT_BUDGET_TOKENS,
} satisfies Partial<ChatConfig>;

export const APP_ASSISTANT_MCP: CivitaiChat['mcp'] = {
  orchestration: { exclude: APP_ASSISTANT_EXCLUDED_TOOLS },
};

/**
 * Replaces the chat's own examples, which are about media-making tools this page excludes. Each is an
 * app built on something the Civitai App SDK gives a block, so a first app shows what only a Civitai
 * app can do.
 */
export const APP_ASSISTANT_EXAMPLES: ChatExample[] = [
  {
    title: 'Character card maker',
    prompt:
      'Build a character card maker: I give a name and a few traits, it generates a portrait, and I can post the card to Civitai',
  },
  {
    title: 'LoRA tester',
    prompt:
      'Make an app where I pick a checkpoint and a LoRA from Civitai and see the same prompt generated with and without the LoRA',
  },
  {
    title: 'Daily prompt challenge',
    prompt:
      'Run a daily challenge with a new theme each day, where people generate an image for it and vote for their favourite entry',
  },
  {
    title: 'Buzz tracker',
    prompt: 'Show my Buzz balance and recent transactions, with a chart of what I spent this week',
  },
];

export const APP_ASSISTANT_PLACEHOLDER = 'Describe the app you want to build';
