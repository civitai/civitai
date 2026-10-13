import {
  getPrompts,
  type LabPrompt,
  type LabPromptVersion,
  type LabPrompts,
} from './harness-client';
import type { PromptKey } from '$lib/text-scan-lab/types';

/** One version of a prompt from its loaded history, and the version live now. Harness failures propagate. */
export async function getVersion(
  key: PromptKey,
  id: number
): Promise<{
  version: LabPromptVersion | null;
  active: LabPrompt | undefined;
  prompts: LabPrompts;
}> {
  const prompts = await getPrompts(key);
  return {
    prompts,
    version: prompts.history?.find((v) => v.id === id && v.key === key) ?? null,
    active: prompts.active[key],
  };
}
