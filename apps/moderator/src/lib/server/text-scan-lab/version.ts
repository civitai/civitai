import {
  LabHarnessError,
  getPrompts,
  type LabPrompt,
  type LabPromptVersion,
  type LabPrompts,
} from './harness-client';
import type { PromptKey } from '$lib/text-scan-lab/types';
import { usersByIds } from '$lib/server/users.service';

export type LoadedPrompts = { ok: true; value: LabPrompts } | { ok: false; error: string };

/** A page's prompts, or the reason they could not load: a failed harness shows as a message, not a 500. */
export const loadPrompts = (key: string, noun: string): Promise<LoadedPrompts> =>
  getPrompts(key).then(
    (value): LoadedPrompts => ({ ok: true, value }),
    (e: unknown): LoadedPrompts => ({
      ok: false,
      error: `Could not load the ${noun}: ${
        e instanceof LabHarnessError ? e.message : 'unexpected error'
      }`,
    })
  );

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

/** Usernames of everyone who wrote a loaded version or the newest version of any key. */
export async function promptAuthors(prompts: LabPrompts | null): Promise<Record<number, string>> {
  if (!prompts) return {};
  const ids = [
    ...(prompts.history ?? []).map((v) => v.createdById),
    ...Object.values(prompts.latest ?? {}).map((l) => l.createdById),
  ].filter((id): id is number => id != null);
  const users = await usersByIds(ids);
  return Object.fromEntries([...users].map(([id, u]) => [id, u.username ?? 'unknown']));
}
