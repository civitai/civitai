import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { listFeaturedImages } from '$lib/server/version-showcase.service';
import { withheldRefusal, withheldRows } from '$lib/server/retracted-media';
import { callModEndpoint } from '$lib/server/user-actions.service';
import { int4Id, parseForm, parseQuery } from '$lib/server/query';
import type { Actions, PageServerLoad } from './$types';

const LIMIT = 100;

const querySchema = z.object({
  image: int4Id.optional().catch(undefined),
  model: int4Id.optional().catch(undefined),
  author: z.string().trim().max(100).catch(''),
  removed: z.literal('1').optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  const { image, model, author, removed } = parseQuery(url, querySchema);
  const { items, hasMore } = await listFeaturedImages({
    imageId: image,
    modelId: model,
    author: author || undefined,
    includeRemoved: removed === '1',
    limit: LIMIT,
  });
  return {
    items: await withheldRows(
      items.map((row) => ({ ...row, restricted: false })),
      locals.user,
      'version-showcases',
      (row) => row.imageId,
      (row) => ({ ...row, imageUrl: '', imageType: 'image', restricted: true })
    ),
    hasMore,
    limit: LIMIT,
    filters: { image: image ?? null, model: model ?? null, author, removed: removed === '1' },
  };
};

export const actions = {
  // The removal marker, cache refresh, cover clear and audit row live in the main app.
  remove: async ({ request, locals }) => {
    const input = parseForm(
      z.object({
        modelVersionId: z.coerce.number().int().positive({ error: 'Missing version id.' }),
        imageId: z.coerce.number().int().positive({ error: 'Missing image id.' }),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });
    const withheld = await withheldRefusal(locals.user, [input.imageId]);
    if (withheld) return fail(403, { error: withheld, imageId: input.imageId });
    const result = await callModEndpoint('version-showcase/remove', input, 'Remove from showcase');
    if (!result.ok) return fail(400, { error: result.error, imageId: input.imageId });
    return { success: true };
  },
} satisfies Actions;
