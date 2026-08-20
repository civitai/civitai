import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { parseForm, parseQuery } from '$lib/server/query';
import { banFieldsSchema, rejectUnexplainedOther } from '$lib/server/ban-input';
import { setBanned } from '$lib/server/user-actions.service';
import {
  ANNOUNCEMENT_COLORS,
  getTrainingAnnouncement,
  getModelOwner,
  getTrainingModelsFeed,
  setTrainingAnnouncement,
  toggleCannotPublish,
} from '$lib/server/training-moderation.service';

const PAGE_SIZE = 24;

// LOCAL day boundaries, matching the main app's date picker — a UTC boundary shifts the window by the
// operator's offset, so the same "from 3 March" returns a different set here than it did there.
// `dateTo` covers the whole day so "to 3 March" includes the 3rd rather than stopping at its first instant.
const localDay = (value: string | undefined, endOfDay: boolean): Date | undefined => {
  if (!value) return undefined;
  const [y, m, d] = value.split('-').map(Number);
  return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d);
};
const dayStart = (value: string | undefined) => localDay(value, false);
const dayEnd = (value: string | undefined) => localDay(value, true);

const querySchema = z.object({
  username: z.string().trim().max(100).catch(''),
  workflowId: z.string().trim().max(100).catch(''),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .catch(undefined),
  publishing: z.enum(['all', 'blocked', 'allowed']).catch('all'),
  cursor: z.coerce.number().int().positive().optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url }) => {
  const q = parseQuery(url, querySchema);

  const [feed, announcement] = await Promise.all([
    getTrainingModelsFeed({
      limit: PAGE_SIZE,
      cursor: q.cursor,
      username: q.username || undefined,
      workflowId: q.workflowId || undefined,
      dateFrom: dayStart(q.from),
      dateTo: dayEnd(q.to),
      cannotPublish: q.publishing === 'all' ? undefined : q.publishing === 'blocked',
    }),
    getTrainingAnnouncement(),
  ]);

  return {
    ...feed,
    filters: q,
    announcement,
    announcementColors: ANNOUNCEMENT_COLORS,
    wide: true,
  };
};

export const actions: Actions = {
  toggleCannotPublish: async ({ request }) => {
    const input = parseForm(
      z.object({ modelId: z.coerce.number().int().positive() }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });

    const result = await toggleCannotPublish(input.modelId);
    return result.ok
      ? { success: true, cannotPublish: result.cannotPublish }
      : fail(400, { error: result.error });
  },

  saveAnnouncement: async ({ request }) => {
    const input = parseForm(
      z.object({
        message: z.string().trim().max(2000),
        color: z.enum(ANNOUNCEMENT_COLORS),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });

    await setTrainingAnnouncement(input);
    return { success: true };
  },

  ban: requiresGrant('audit.ban.execute', async ({ request, locals }) => {
    const input = parseForm(
      banFieldsSchema.extend({ modelId: z.coerce.number().int().positive() }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });
    const unexplained = rejectUnexplainedOther(input);
    if (unexplained) return fail(400, { error: unexplained });

    // The account banned is the model's owner, resolved here. `audit.ban.execute` is deliberately held
    // apart from /users, so a holder has no account page — and a posted id would let them ban anything.
    const owner = await getModelOwner(input.modelId);
    if (!owner) return fail(404, { error: 'Model not found.' });

    const result = await setBanned({
      userId: owner.userId,
      ban: true,
      reasonCode: input.reasonCode,
      detailsInternal: input.detailsInternal || undefined,
      detailsExternal: input.detailsExternal || undefined,
      removeMedia: input.removeMedia,
      removeModels: input.removeModels,
      moderatorId: locals.user.id,
    });
    return result.ok ? { success: true } : fail(400, { error: result.error });
  }),
};
