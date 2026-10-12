import {
  getPrompts,
  type LabPrompt,
  type LabPromptVersion,
  type LabPrompts,
} from './harness-client';
import type { PromptKey } from '$lib/text-scan-lab/types';

/** One version of a prompt out of its loaded history, with the version live now and the whole read (Check needs every key's active). Harness failures propagate: callers word them. */
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
