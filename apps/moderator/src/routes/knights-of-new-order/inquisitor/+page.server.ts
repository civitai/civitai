import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { holdsCsamReview } from '$lib/server/held-media';
import { int4Id, parseForm } from '$lib/server/query';
import { parseInquisitorFilter } from '$lib/knights/inquisitor-filters';
import {
  countInquisitorQueueByFilter,
  getInquisitorQueue,
  INQUISITOR_QUEUE_LIMIT,
  inquisitorItemImageId,
  ruleOnInquisitorItem,
} from '$lib/server/knights/inquisitor.service';
import { withheldRefusal } from '$lib/server/retracted-media';
import { WithheldImageError } from '$lib/server/withheld-write';

const rulingForm = z.object({
  itemId: int4Id,
  level: z.coerce.number().int(),
  blockReason: z.string().optional(),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  requireAccess(locals.user, url.pathname);
  const filter = parseInquisitorFilter(url.searchParams.get('filter'));
  const [items, counts] = await Promise.all([
    getInquisitorQueue(filter, { csamReview: holdsCsamReview(locals.user) }),
    countInquisitorQueueByFilter(),
  ]);
  return {
    limit: INQUISITOR_QUEUE_LIMIT,
    filter,
    counts,
    items,
    fullBleed: true,
    headerInline: true,
  };
};

export const actions: Actions = {
  rule: async ({ request, locals, url }) => {
    requireAccess(locals.user, url.pathname);
    const input = parseForm(rulingForm, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    try {
      const { itemId, level, blockReason } = input;
      const imageId = await inquisitorItemImageId(itemId);
      const withheld = imageId === null ? null : await withheldRefusal(locals.user, [imageId]);
      if (withheld) return fail(403, { error: withheld, key: itemId });
      const result = await ruleOnInquisitorItem(itemId, { level, blockReason }, locals.user.id, {
        csamReview: holdsCsamReview(locals.user),
      });
      return result.ok ? { success: true } : fail(409, { error: result.error, key: itemId });
    } catch (error) {
      if (error instanceof WithheldImageError)
        return fail(403, { error: error.message, key: input.itemId });
      console.error('knights inquisitor: could not set the rating', {
        itemId: input.itemId,
        error,
      });
      return fail(500, { error: 'The rating could not be set. Nothing was changed; try again.' });
    }
  },
};
