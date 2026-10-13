import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { parseForm } from '$lib/server/query';
import { LabHarnessError, getPrompts } from '$lib/server/text-scan-lab/harness-client';
import { publishChanges, publishSchema } from '$lib/server/text-scan-lab/publish';
import { runTry } from '$lib/server/text-scan-lab/try';
import { PROMPT_KEYS, type PromptKey } from '$lib/text-scan-lab/types';

export type { TryItem as CheckItemResult, TryResult as CheckResult } from '$lib/text-scan-lab/try';

/** The current prompts: their text, and each version's id, which a publish checks is still current. */
export type ActivePrompts =
  | {
      ok: true;
      content: Partial<Record<PromptKey, string>>;
      ids: Partial<Record<PromptKey, number>>;
    }
  | { ok: false; error: string };

export const load: PageServerLoad = async () => {
  const active = await getPrompts().then(
    (p): ActivePrompts => {
      const keys = PROMPT_KEYS.filter((k) => p.active[k]);
      return {
        ok: true,
        content: Object.fromEntries(keys.map((k) => [k, p.active[k].content])),
        ids: Object.fromEntries(keys.map((k) => [k, p.active[k].id])),
      };
    },
    (e: unknown): ActivePrompts => ({
      ok: false,
      error: `Could not load the current prompts: ${
        e instanceof LabHarnessError ? e.message : 'unexpected error'
      }`,
    })
  );
  return { active, wide: true };
};

export const actions: Actions = {
  check: async ({ request }) => runTry(await request.formData()),

  publish: requiresGrant('textScan.prompt.publish', async ({ request }) => {
    const input = parseForm(publishSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    return publishChanges(input);
  }),
};
