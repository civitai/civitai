import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { validNsfwLevels, NsfwLevel } from '$lib/browsing-levels';
import {
  getImageRatingRequests,
  updateImageNsfwLevel,
} from '$lib/server/image-rating-review.service';

const querySchema = z.object({
  cursor: z.coerce.number().int().positive().optional().catch(undefined),
  limit: z.coerce.number().int().min(10).max(100).catch(50),
});

export const load: PageServerLoad = async ({ url }) => {
  const { cursor, limit } = parseQuery(url, querySchema);
  const data = await getImageRatingRequests({ cursor, limit });
  return { limit, wide: true, civitaiUrl: env.CIVITAI_APP_URL ?? 'https://civitai.com', ...data };
};

const isRatingLevel = (n: number) => validNsfwLevels.has(n) || n === NsfwLevel.Blocked;

// Access is enforced globally (hooks.server.ts). The mutation runs internally via Kysely.
export const actions: Actions = {
  setLevel: async ({ request, locals }) => {
    const form = await request.formData();
    const id = Number(form.get('id'));
    const nsfwLevel = Number(form.get('nsfwLevel'));

    if (!id) return fail(400, { error: 'Missing image id.' });
    if (!isRatingLevel(nsfwLevel)) return fail(400, { error: 'Invalid rating level.' });

    await updateImageNsfwLevel({ id, nsfwLevel, status: 'Actioned', userId: locals.user.id });
    return { success: true, id, nsfwLevel };
  },
};
