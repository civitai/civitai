import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { parseForm, parseQuery } from '$lib/server/query';
import {
  LabHarnessError,
  getPrompts,
  type LabPrompts,
} from '$lib/server/text-scan-lab/harness-client';
import {
  restorePrompt,
  restoreSchema,
  savePrompt,
  saveSchema,
} from '$lib/server/text-scan-lab/prompt-save';
import { runTry } from '$lib/server/text-scan-lab/try';
import { promptAuthors } from '$lib/server/text-scan-lab/version';
import { cancelAction, quoteAction, startAction } from '$lib/server/text-scan-tests/form-actions';
import { PROMPT_KEYS } from '$lib/text-scan-lab/types';

const querySchema = z.object({ key: z.enum(PROMPT_KEYS).catch('base') });

export type LoadedPrompts = { ok: true; value: LabPrompts } | { ok: false; error: string };

export const load: PageServerLoad = async ({ url }) => {
  const q = parseQuery(url, querySchema);
  const prompts = await getPrompts(q.key).then(
    (value): LoadedPrompts => ({ ok: true, value }),
    (e: unknown): LoadedPrompts => ({
      ok: false,
      error: `Could not load the prompts: ${
        e instanceof LabHarnessError ? e.message : 'unexpected error'
      }`,
    })
  );
  const authors = await promptAuthors(prompts.ok ? prompts.value : null);
  return { key: q.key, prompts, authors, wide: true };
};

export const actions: Actions = {
  try: async ({ request }) => runTry(await request.formData()),

  save: requiresGrant('textScan.prompt.publish', async ({ request }) => {
    const input = parseForm(saveSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    return savePrompt(input);
  }),

  restore: requiresGrant('textScan.prompt.publish', async ({ request }) => {
    const input = parseForm(restoreSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    return restorePrompt(input);
  }),

  quoteRun: (event) => quoteAction(event, 'prompts'),
  startRun: (event) => startAction(event, 'prompts'),
  cancelRun: (event) => cancelAction(event),
};
