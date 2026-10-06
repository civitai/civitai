import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess, requiresGrant } from '$lib/server/access';
import { parseForm, parseQuery } from '$lib/server/query';
import {
  createDraft,
  getVisibleDraft,
  listDrafts,
  updateDraft,
  type PromptDraft,
} from '$lib/server/text-scan-lab/drafts.service';
import { refused } from '$lib/server/text-scan-lab/errors';
import { LabHarnessError, getPrompts, type LabPrompts } from '$lib/server/text-scan-lab/harness-client';
import {
  draftIdField,
  draftPromptsField,
  draftRunTotals,
  expectedUpdatedAtField,
  publishDraft,
  publishSchema,
} from '$lib/server/text-scan-lab/publish';
import { PROMPT_KEYS } from '$lib/text-scan-lab/types';

const querySchema = z.object({
  key: z.enum(PROMPT_KEYS).catch('base'),
  draft: z.coerce.number().int().positive().optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  const q = parseQuery(url, querySchema);
  const [drafts, prompts] = await Promise.all([
    listDrafts(),
    getPrompts(q.key).then(
      (p): { ok: true; value: LabPrompts } => ({ ok: true, value: p }),
      (e: unknown) => ({
        ok: false as const,
        error: `Could not load prompts: ${
          e instanceof LabHarnessError ? e.message : 'unexpected error'
        }`,
      })
    ),
  ]);
  const draft: PromptDraft | null = q.draft
    ? drafts.find((d) => d.id === q.draft) ?? (await getVisibleDraft(q.draft, locals.user.id))
    : null;
  const runTotals =
    draft && canAccess(locals.user, '/text-scan/test-sets') ? await draftRunTotals(draft.id) : [];
  return { key: q.key, drafts, draft, prompts, runTotals, wide: true };
};

const fail400 = (error: string) => fail(400, { error });

const noteField = z
  .string()
  .trim()
  .max(2000, 'Note is at most 2000 characters.')
  .transform((v) => v || null);

export const actions: Actions = {
  createDraft: async ({ request, locals }) => {
    const input = parseForm(
      z.object({
        name: z
          .string()
          .trim()
          .min(1, 'Name the draft.')
          .max(100, 'Name is at most 100 characters.'),
        note: noteField.optional().default(null),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail400(input);
    try {
      const draft = await createDraft({ ...input, prompts: {} }, locals.user.id);
      return { success: true, draftId: draft.id };
    } catch (e) {
      return refused(e);
    }
  },

  saveDraft: async ({ request, locals }) => {
    const input = parseForm(
      z.object({
        draftId: draftIdField,
        prompts: draftPromptsField,
        note: noteField.optional().default(null),
        expectedUpdatedAt: expectedUpdatedAtField,
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail400(input);
    try {
      await updateDraft(input.draftId, input, locals.user.id);
      return { success: true };
    } catch (e) {
      return refused(e);
    }
  },

  publish: requiresGrant('textScan.prompt.publish', async ({ request, locals }) => {
    const input = parseForm(publishSchema, await request.formData());
    if (typeof input === 'string') return fail400(input);
    return publishDraft(input, locals.user.id);
  }),
};
