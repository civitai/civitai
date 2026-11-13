/**
 * The reply budgets App Assistant's page configures (`APP_ASSISTANT_MAX_STEPS` and
 * `APP_ASSISTANT_CONTEXT_BUDGET_TOKENS` in civitai's
 * `src/components/Apps/AppAssistant/assistantChatConfig.ts`), as the runner's defaults. The runner
 * cannot import the page's module, so a civitai test pins these equal to it
 * (`src/components/Apps/AppAssistant/__tests__/assistant-runner-parity.test.ts`).
 */
export const DEFAULT_MAX_STEPS = 1000;
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 64_000;
