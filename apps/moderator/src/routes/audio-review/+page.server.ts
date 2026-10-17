import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { getAudioReviews, recordAudioReview } from '$lib/server/audio-review.service';

const querySchema = z.object({
  filter: z.enum(['flagged', 'all', 'failed', 'reviewed']).catch('flagged'),
  cursor: z.coerce.number().int().positive().max(2147483647).optional().catch(undefined),
});
const reviewSchema = z.object({
  id: z.coerce.number().int().positive().max(2147483647),
  sourceHash: z.string().regex(/^[a-f0-9]{32}$/),
  wouldBlock: z.enum(['yes', 'no']).transform((value) => value === 'yes'),
  notes: z.string().trim().max(2000),
});

export const load: PageServerLoad = async ({ url }) => {
  const { filter, cursor } = querySchema.parse(Object.fromEntries(url.searchParams));
  return { ...(await getAudioReviews(filter, cursor)), filter };
};

export const actions: Actions = {
  review: requiresGrant('audio.review', async ({ request, locals }) => {
    const input = reviewSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!input.success) return fail(400, { error: 'Check the review fields and try again.' });
    try {
      const saved = await recordAudioReview({ ...input.data, reviewerId: locals.user.id });
      if (!saved)
        return fail(409, {
          error: 'This scan was already reviewed or the media changed. Refresh the queue.',
        });
      return { success: true };
    } catch {
      return fail(500, { error: 'The review could not be saved. Please try again.' });
    }
  }),
};
