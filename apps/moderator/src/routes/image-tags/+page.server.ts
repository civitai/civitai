import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { getImageTagReviewQueue, moderateImageTags } from '$lib/server/image-tags.service';

const querySchema = z.object({
  cursor: z.coerce.number().int().positive().optional().catch(undefined),
  limit: z.coerce.number().int().min(10).max(100).catch(50),
});

export const load: PageServerLoad = async ({ url }) => {
  const { cursor, limit } = parseQuery(url, querySchema);
  const data = await getImageTagReviewQueue({ cursor, limit });
  return { limit, wide: true, civitaiUrl: env.CIVITAI_APP_URL ?? 'https://civitai.com', ...data };
};

// Access is enforced globally (hooks.server.ts). `disable=true` approves the removal (tag disabled),
// `disable=false` keeps it; either clears needsReview. A `tagId` scopes it to one tag; omitting it acts
// on every needsReview Moderation tag on the image.
export const actions: Actions = {
  moderate: async ({ request, locals }) => {
    const form = await request.formData();
    const imageId = Number(form.get('imageId'));
    const disable = form.get('disable') === 'true';
    const rawTagId = form.get('tagId');
    const tagId = rawTagId != null && rawTagId !== '' ? Number(rawTagId) : undefined;

    if (!imageId) return fail(400, { error: 'Missing image id.' });
    if (tagId !== undefined && !Number.isFinite(tagId)) return fail(400, { error: 'Invalid tag id.' });

    const { tagIds } = await moderateImageTags({
      imageId,
      tagIds: tagId !== undefined ? [tagId] : undefined,
      disable,
      userId: locals.user.id,
    });
    return { success: true, imageId, tagIds, disable };
  },

  // Bulk verdict over the selected cards — acts on every needsReview tag of each image.
  bulkModerate: async ({ request, locals }) => {
    const form = await request.formData();
    const disable = form.get('disable') === 'true';
    const imageIds = String(form.get('imageIds') ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0);

    await Promise.all(
      imageIds.map((imageId) => moderateImageTags({ imageId, disable, userId: locals.user.id }))
    );
    return { success: true };
  },
};
