import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { validNsfwLevels, NsfwLevel } from '$lib/browsing-levels';
import { getDownleveledImages } from '$lib/server/downleveled-review.service';
import { updateImageNsfwLevel } from '$lib/server/image-nsfw-level';

const querySchema = z.object({
  cursor: z.string().optional().catch(undefined),
  limit: z.coerce.number().int().min(10).max(100).catch(50),
  originalLevel: z.coerce.number().int().positive().optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url }) => {
  const { cursor, limit, originalLevel } = parseQuery(url, querySchema);
  const data = await getDownleveledImages({ cursor, limit, originalLevel });
  return {
    limit,
    originalLevel: originalLevel ?? null,
    wide: true,
    civitaiUrl: env.CIVITAI_APP_URL ?? 'https://civitai.com',
    ...data,
  };
};

const isRatingLevel = (n: number) => validNsfwLevels.has(n) || n === NsfwLevel.Blocked;

// Access is enforced globally (hooks.server.ts). Runs internally via Kysely; no rating request to resolve
// here, so updateImageNsfwLevel is called without a status.
export const actions: Actions = {
  setLevel: async ({ request, locals }) => {
    const form = await request.formData();
    const id = Number(form.get('id'));
    const nsfwLevel = Number(form.get('nsfwLevel'));

    if (!id) return fail(400, { error: 'Missing image id.' });
    if (!isRatingLevel(nsfwLevel)) return fail(400, { error: 'Invalid rating level.' });

    await updateImageNsfwLevel({ id, nsfwLevel, userId: locals.user.id });
    return { success: true, id, nsfwLevel };
  },
};
