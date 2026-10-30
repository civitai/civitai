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

// Each id is in OpenRouter's public model list with tool calling. Cost hints compare its list price
// per million output tokens with the default's when it was added (GPT-6 Luna $0.50, GLM 5.3 Flash
// $0.07, Claude Haiku 5.5 $0.50, DeepSeek V4.1 Flash $0.50); the charge follows the actual price.
export const APP_ASSISTANT_MODELS: readonly AppAssistantModel[] = [
  { id: APP_ASSISTANT_DEFAULT_MODEL, label: 'GPT-6 Luna', note: 'Standard cost' },
  { id: 'z-ai/glm-5.3-flash', label: 'GLM 5.3 Flash', note: 'Lower cost' },
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5', note: 'About the same cost' },
  { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', note: 'About the same cost' },
];

const IDS: ReadonlySet<string> = new Set(APP_ASSISTANT_MODELS.map((model) => model.id));

/** Whether App Assistant offers `id`: exactly one of {@link APP_ASSISTANT_MODELS}' ids. */
export function isAppAssistantModel(id: unknown): id is string {
  return typeof id === 'string' && IDS.has(id);
}
