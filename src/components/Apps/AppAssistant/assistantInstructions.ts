// App Assistant's prompt lives in `@civitai/app-assistant`, so the server runner builds the same one.
export {
  APP_ASSISTANT_RULES,
  APP_ASSISTANT_SUBAGENT_RULES,
  REMOTE_NO_PREVIEW,
  buildAssistantInstructions,
  buildAssistantSystemPrompt,
  buildAssistantSystemPromptWithSubagents,
} from '@civitai/app-assistant';
export type { AssistantInstructionsInput } from '@civitai/app-assistant';
