import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getIngestionErrorImages, resolveIngestionError } from '$lib/server/ingestion.service';
import { ingestionErrorLevelSet } from '@civitai/shared';
import { holdsCsamReview } from '$lib/server/held-media';
import { listWithheldIds, withheldRefusal, withheldRow } from '$lib/server/retracted-media';

const LIMIT_OPTIONS = [10, 25, 50, 100];

export const load: PageServerLoad = async ({ url, locals }) => {
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = LIMIT_OPTIONS.includes(limitParam) ? limitParam : 50;
  const cursor = Number(url.searchParams.get('cursor')) || undefined;

  const { items, nextCursor } = await getIngestionErrorImages({ limit, cursor });
  const withheld = await listWithheldIds(
    items.map((i) => i.id),
    { csamReview: holdsCsamReview(locals.user) },
    'ingestion-errors'
  );
  return {
    limit,
    limitOptions: LIMIT_OPTIONS,
    wide: true,
    nextCursor,
    items: items.map((i) => (withheld.has(i.id) ? withheldRow(i) : { ...i, restricted: false })),
  };
};

// Access is enforced globally (hooks.server.ts). Resolve runs internally via Kysely.
export const actions: Actions = {
  resolve: async ({ request, locals }) => {
    const form = await request.formData();
    const id = Number(form.get('id'));
    const nsfwLevel = Number(form.get('nsfwLevel'));

    if (!id) return fail(400, { error: 'Missing image id' });
    if (!ingestionErrorLevelSet.has(nsfwLevel)) return fail(400, { error: 'Invalid NSFW level' });
    const withheld = await withheldRefusal(locals.user, [id]);
    if (withheld) return fail(403, { error: withheld });

    try {
      await resolveIngestionError({
        id,
        nsfwLevel,
        userId: locals.user.id,
        csamReview: holdsCsamReview(locals.user),
      });
    } catch (e) {
      return fail(400, { error: e instanceof Error ? e.message : 'Failed to resolve.' });
    }
    return { success: true, id, nsfwLevel };
  },
};
