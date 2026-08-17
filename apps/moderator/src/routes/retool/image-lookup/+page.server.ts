import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { setImageFlag } from '$lib/server/user-actions.service';
import { lookupQuerySchema, parseForm, parseQuery } from '$lib/server/query';
import {
  asId,
  getImageLookup,
  getPostLookup,
  resolveImageId,
  resolvePostId,
} from '$lib/server/image-lookup.service';
import { hasImageEvents } from '$lib/server/image-signals.service';

// Retool's Image Lookup could write: a screenshot of the live app shows `Toggle Minor ON` and
// `Toggle Poi ON` beside the image data. Its export carries no mutation query and is stale against that
// screen, so the actions come from the endpoint Bulk Image Manager already uses.
export const load: PageServerLoad = async ({ url, locals }) => {
  const { q } = parseQuery(url, lookupQuerySchema);
  // `?post=` is what the main app's "Lookup Post" control appends its id to. Kept distinct from `q` so a
  // bare number in the search box stays an image id — the overwhelmingly common case.
  const postParam = url.searchParams.get('post')?.trim() ?? '';
  // `asId`, not `Number`: `Post.id` is a Postgres integer, so an over-long id ERRORS the comparison
  // rather than missing it, and an uncaught throw in `load` renders a 500 instead of "no post matches".
  const postId = /^\d+$/.test(postParam) ? asId(postParam) : resolvePostId(q);

  if (postId) {
    const post = await getPostLookup(postId);
    return {
      // NOT the post id. `LookupSearch` replaces the whole query string on submit, so echoing it here
      // meant pressing Search turned `?post=123` into `?q=123` — which resolves as an IMAGE id and
      // renders an unrelated image with the flag actions live on it. PostPanel names the post instead.
      q: '',
      result: null,
      post,
      postId,
      deletedImageId: null,
      notFound: false,
      canAct: canAccess(locals.user, '/retool/image-lookup'),
    };
  }

  if (!q)
    return {
      q,
      result: null,
      post: null,
      postId: null,
      deletedImageId: null,
      notFound: false,
      canAct: false,
    };

  const imageId = await resolveImageId(q);
  const result = imageId ? await getImageLookup(imageId) : null;

  // A ToS deletion removes the Image row but leaves the ClickHouse lifecycle log — which is the record of
  // WHY it was removed, and the thing a moderator is looking for when an id no longer resolves.
  //
  // Gated on the log ACTUALLY having events. An id is just digits: a moderator transposing one from a
  // report would otherwise be told "Image #… no longer exists — which is what a ToS removal does", and
  // could reasonably close the report believing the content was found and actioned. An id with no row and
  // no events never existed.
  // Guarded: this is the only ClickHouse call in `load`, and it runs on the MISS path — so without the
  // catch, ClickHouse being down turns "no image matches" into an error page.
  let deletedImageId: number | null = null;
  if (!result && imageId) {
    try {
      if (await hasImageEvents(imageId)) deletedImageId = imageId;
    } catch (e) {
      console.error('[image-lookup] deleted-image check unavailable', e);
    }
  }

  return {
    q,
    result,
    post: null,
    postId: null,
    deletedImageId,
    notFound: !result && !deletedImageId,
    canAct: canAccess(locals.user, '/retool/image-lookup'),
  };
};

export const actions: Actions = {
  // Retool's Toggle Minor / Toggle Poi. Same endpoint Bulk Image Manager uses, so the flag write has
  // one implementation and one audit trail; Retool could only ever turn them ON.
  setFlag: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/retool/image-lookup'))
      return fail(400, { error: 'Not permitted.' });
    const input = parseForm(
      z.object({
        imageId: z.coerce.number().int().positive(),
        flagValue: z.enum(['poi:true', 'poi:false', 'minor:true', 'minor:false']),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });

    const [flag, value] = input.flagValue.split(':');
    const result = await setImageFlag({
      imageIds: [input.imageId],
      flag: flag as 'poi' | 'minor',
      value: value === 'true',
      moderatorId: locals.user.id,
    });
    if (!result.ok) return fail(400, { error: result.error });
    return { success: true };
  },
};
