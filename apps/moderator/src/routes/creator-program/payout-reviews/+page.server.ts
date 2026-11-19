import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { PAYOUT_REVIEW_ACTIONS, STALE_REVIEW, UNCONFIRMED_DECISION } from '$lib/payout-review';
import { requiresGrant } from '$lib/server/access';
import { lastSettlementAt, listPayoutReviews } from '$lib/server/payout-reviews';
import { parseForm } from '$lib/server/query';
import { responseMayHaveLanded } from '$lib/server/rest-error-reason';
import { decidePayoutReview } from '$lib/server/user-actions.service';

export const load: PageServerLoad = async ({ url }) => {
  const view = url.searchParams.get('view') === 'cleared' ? 'cleared' : 'holding';
  const now = new Date();
  const { items, hasMore } = await listPayoutReviews(view, { now });
  return { view, items, hasMore, lastSettlementAt: lastSettlementAt(now) };
};

const decideSchema = z.object({
  id: z.coerce.number().int().positive({ error: 'Missing review id.' }),
  userId: z.coerce.number().int().positive({ error: 'Missing user id.' }),
  period: z.string().regex(/^\d{4}-\d{2}$/, { error: 'Missing period.' }),
  action: z.enum(PAYOUT_REVIEW_ACTIONS, { error: 'Pick a decision.' }),
  version: z.coerce.number().int().positive({ error: 'Missing version.' }),
  note: z
    .string({ error: 'A note is required.' })
    .trim()
    .min(1, { error: 'A note is required.' })
    .max(2000, { error: 'The note is too long.' }),
  askRef: z
    .string()
    .trim()
    .max(200, { error: 'The ask reference is too long.' })
    .optional()
    .transform((v) => v || undefined),
});

export const actions: Actions = {
  decide: requiresGrant('creatorProgram.payoutReview.decide', async ({ request }) => {
    const input = parseForm(decideSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });

    const result = await decidePayoutReview(input);
    if (result.ok) return { success: true as const, id: input.id };
    if (result.status === 409)
      return fail(409, { id: input.id, error: STALE_REVIEW, reason: result.reason ?? null });
    if (responseMayHaveLanded(result))
      return fail(502, { id: input.id, error: UNCONFIRMED_DECISION });
    const status =
      result.status && result.status >= 400 && result.status < 600 ? result.status : 502;
    return fail(status, { id: input.id, error: result.error });
  }),
};
