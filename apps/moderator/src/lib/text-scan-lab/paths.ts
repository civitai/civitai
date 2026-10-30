import type { PromptKey } from './types';

export const PROMPTS_PATH = '/text-scan/prompts';

export const promptsHref = (key?: PromptKey) =>
  key ? `${PROMPTS_PATH}?${new URLSearchParams({ key })}` : PROMPTS_PATH;
