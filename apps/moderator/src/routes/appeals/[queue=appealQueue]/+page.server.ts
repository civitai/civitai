import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { parseForm, parseQueryKeys } from '$lib/server/query';
import { checkedResolutionReason, resolutionReasonFields } from '$lib/server/resolution-reason';
import {
  countSiteAppealQueue,
  getSiteAppealQueue,
  resolveSiteAppeal,
} from '$lib/server/site-appeals.service';
import { siteAppealQueueForSlug } from '$lib/site-appeals';

const LIMIT = 50;
const querySchema = z.object({ page: z.coerce.number().int().min(1).max(500).catch(1) });

export const load: PageServerLoad = async ({ params, url }) => {
  // The matcher has already refused any other slug; this only narrows the type.
  const queue = siteAppealQueueForSlug(params.queue);
  if (!queue) error(404, 'Unknown appeal queue');

  const { page } = parseQueryKeys(url, querySchema);
  const offset = (page - 1) * LIMIT;
  const [list, total] = await Promise.all([
    getSiteAppealQueue({ category: queue.category, limit: LIMIT, offset }),
    // The footer's "of N" is decoration; a failure here must not take the list down with it.
    countSiteAppealQueue(queue.category).catch(() => undefined),
  ]);
  return { queue, page, offset, total, ...list, fullBleed: true };
};

const resolveSchema = z.object({
  appealId: z.coerce.number().int().positive(),
  status: z.enum(['Approved', 'Rejected']),
  resolvedMessage: z.string().trim().max(1000).optional(),
  ...resolutionReasonFields,
});

export const actions: Actions = {
  resolve: async ({ params, request, locals }) => {
    const queue = siteAppealQueueForSlug(params.queue);
    if (!queue) return fail(404, { error: 'Unknown appeal queue.' });
    const input = parseForm(resolveSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    const reason = checkedResolutionReason('appeal', input.status, input);
    if (typeof reason === 'string') return fail(400, { error: reason, appealId: input.appealId });

    const result = await resolveSiteAppeal({
      appealId: input.appealId,
      category: queue.category,
      decision: input.status,
      resolvedMessage: input.resolvedMessage || undefined,
      ...reason,
      moderatorId: locals.user.id,
      canBan: locals.grants['user.ban'] === true,
    });
    if (!result.ok)
      return fail(result.conflict ? 409 : 400, { error: result.error, appealId: input.appealId });
    return {
      success: true,
      appealId: input.appealId,
      lifted: result.lifted,
      restored: result.restored,
    };
  },
};
