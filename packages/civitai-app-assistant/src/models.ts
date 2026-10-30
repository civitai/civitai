/**
 * The models App Assistant's replies may use: the one place both the page (its model button) and the
 * server runner (which refuses any other id) read them from. Each is an OpenRouter id, which the
 * orchestrator routes to OpenRouter, so every step is paid at that model's price.
 */
export interface AppAssistantModel {
  id: string;
  /** What the model button calls it. */
  label: string;
  /** A short cost hint the model button shows beside it. */
  note: string;
}

/** Replies use this one unless the viewer picks another for the chat. */
export const APP_ASSISTANT_DEFAULT_MODEL = 'openai/gpt-6-luna';

// Cost hints are relative to the default, from OpenRouter's list prices per million output tokens
// when each was added (GPT-6 Luna $0.50, GLM 5.3 Flash $0.50, GLM 5.3 $1.40, Step 5 Preview $2.70).
export const APP_ASSISTANT_MODELS: readonly AppAssistantModel[] = [
  { id: APP_ASSISTANT_DEFAULT_MODEL, label: 'GPT-6 Luna', note: 'Lowest cost' },
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', note: 'About the same cost' },
  { id: 'z-ai/glm-5.3', label: 'GLM 5.3', note: 'About 3× the cost' },
  { id: 'stepfun/step-5-preview', label: 'Step 5 Preview', note: 'About 5× the cost' },
];

const IDS: ReadonlySet<string> = new Set(APP_ASSISTANT_MODELS.map((model) => model.id));

/** Whether App Assistant offers `id`: exactly one of {@link APP_ASSISTANT_MODELS}' ids. */
export function isAppAssistantModel(id: unknown): id is string {
  return typeof id === 'string' && IDS.has(id);
}
