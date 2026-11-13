import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { recordModActivity } from '$lib/server/mod-activity';
import { getModeratorDb } from '$lib/server/moderator-db';
import { parseForm } from '$lib/server/query';
import { composeEntities } from '$lib/server/text-scan-lab/harness-client';
import { readerOf, recordChatMessageReads } from '$lib/server/chat-read-audit';
import { captureCase, captureSchema } from '$lib/server/text-scan-tests/capture';
import { refusal, requireWorkspace } from '$lib/server/text-scan-tests/guard';
import { createSet } from '$lib/server/text-scan-tests/store';
import { refreshSetTotals } from '$lib/server/text-scan-tests/totals';
import { promptsHref } from '$lib/text-scan-lab/paths';
import { TEST_SET_LIMITS, WORKSPACES } from '$lib/text-scan-tests/types';

export const load: PageServerLoad = () => {
  redirect(307, promptsHref());
};

const createSetSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name the set.')
    .max(TEST_SET_LIMITS.nameChars, 'A set name is at most 100 characters.'),
  description: z
    .string()
    .trim()
    .max(TEST_SET_LIMITS.descriptionChars, 'A description is at most 2000 characters.')
    .optional()
    .transform((v) => v || null),
  workspace: z.enum(WORKSPACES),
});

const recordSetCreated = (userId: number, setId: number) =>
  recordModActivity({
    userId,
    entityType: 'textScanTestSet',
    entityId: setId,
    activity: 'textScan.testSet.create',
  });

export const actions: Actions = {
  createSet: requiresGrant('textScan.testSets.edit', async ({ request, locals }) => {
    const input = parseForm(createSetSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    try {
      requireWorkspace(locals.user, input.workspace);
      const set = await createSet(getModeratorDb(), input, locals.user.id);
      await recordSetCreated(locals.user.id, set.id);
      return { success: true, setId: set.id };
    } catch (e) {
      return refusal(e);
    }
  }),

  addCase: requiresGrant('textScan.testSets.edit', async ({ request, locals }) => {
    const input = parseForm(captureSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    try {
      requireWorkspace(locals.user, input.workspace);
      const db = getModeratorDb();
      const compose: typeof composeEntities = async (type, ids, credential) => {
        const composed = await composeEntities(type, ids, credential);
        if (type === 'ChatMessage')
          await recordChatMessageReads(
            readerOf(locals.user),
            composed.filter((c) => c.ok).map((c) => c.entityId)
          );
        return composed;
      };
      const saved = await captureCase({ db, compose }, input, locals.user.id);
      if (saved.setCreated) await recordSetCreated(locals.user.id, saved.setId);
      await recordModActivity({
        userId: locals.user.id,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        activity: 'textScan.testCase.add',
      });
      if (saved.rescore) await refreshSetTotals(db, saved.setId);
      return { success: true, ...saved };
    } catch (e) {
      return refusal(e);
    }
  }),
};
