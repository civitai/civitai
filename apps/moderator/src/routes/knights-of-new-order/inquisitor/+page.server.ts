import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { int4Id, parseForm } from '$lib/server/query';
import {
  getInquisitorQueue,
  INQUISITOR_QUEUE_LIMIT,
  ruleOnInquisitorItem,
} from '$lib/server/knights/inquisitor.service';

const rulingForm = z.object({ itemId: int4Id, level: z.coerce.number().int() });

export const load: PageServerLoad = async ({ url, locals }) => {
  requireAccess(locals.user, url.pathname);
  return { limit: INQUISITOR_QUEUE_LIMIT, items: await getInquisitorQueue() };
};

export const actions: Actions = {
  rule: async ({ request, locals, url }) => {
    requireAccess(locals.user, url.pathname);
    const input = parseForm(rulingForm, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    try {
      const result = await ruleOnInquisitorItem(input.itemId, input.level, locals.user.id);
      return result.ok ? { success: true } : fail(409, { error: result.error });
    } catch (error) {
      console.error('knights inquisitor: could not set the rating', {
        itemId: input.itemId,
        error,
      });
      return fail(500, { error: 'The rating could not be set. Nothing was changed; try again.' });
    }
  },
};
