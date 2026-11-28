import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { getDownleveledImages } from '$lib/server/downleveled-review.service';
import { SongRatingRefusedError, updateImageNsfwLevel } from '$lib/server/image-nsfw-level';
import { holdsCsamReview } from '$lib/server/held-media';
import { WithheldImageError } from '$lib/server/withheld-write';
import { isRatingLevel } from '$lib/nsfw-levels';
import { withheldRefusal, withheldRow, withheldRows } from '$lib/server/retracted-media';

const querySchema = z.object({
  cursor: z.string().optional().catch(undefined),
  limit: z.coerce.number().int().min(10).max(100).catch(50),
  originalLevel: z.coerce.number().int().positive().optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  const { cursor, limit, originalLevel } = parseQuery(url, querySchema);
  const { items, nextCursor } = await getDownleveledImages({ cursor, limit, originalLevel });
  return {
    limit,
    originalLevel: originalLevel ?? null,
    wide: true,
    items: await withheldRows(items, locals.user, 'downleveled', (i) => i.id, withheldRow),
    nextCursor,
  };
};

// Access is enforced globally (hooks.server.ts). Runs internally via Kysely; no rating request to resolve
// here, so updateImageNsfwLevel is called without a status.
export const actions: Actions = {
  setLevel: async ({ request, locals }) => {
    const form = await request.formData();
    const id = Number(form.get('id'));
    const nsfwLevel = Number(form.get('nsfwLevel'));

    if (!id) return fail(400, { error: 'Missing image id.' });
    if (!isRatingLevel(nsfwLevel)) return fail(400, { error: 'Invalid rating level.' });
    const withheld = await withheldRefusal(locals.user, [id]);
    if (withheld) return fail(403, { error: withheld, id });

    try {
      await updateImageNsfwLevel({
        id,
        nsfwLevel,
        reason: 'Moderator downleveled review',
        userId: locals.user.id,
        csamReview: holdsCsamReview(locals.user),
      });
    } catch (e) {
      if (e instanceof WithheldImageError) return fail(403, { error: e.message, id });
      if (e instanceof SongRatingRefusedError) return fail(409, { error: e.message, id });
      throw e;
    }
    return { success: true, id, nsfwLevel };
  },
};
