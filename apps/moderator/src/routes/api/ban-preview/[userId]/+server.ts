import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireIdParam } from '$lib/server/api-guard';
import { getBanContentPreview } from '$lib/server/user-actions.service';

// Fetched by the ban confirmation rather than loaded with the page: it is two COUNTs against a
// moderated account's whole library, and almost every page render never opens the form.
export const GET: RequestHandler = async ({ params, locals }) => {
  // Any page that can offer a ban may read the preview; the ban itself is gated on its own grant.
  const userId = requireIdParam(
    locals,
    params.userId,
    ['/audit/generator-restrictions', '/audit/training-models', '/retool/user-lookup', '/users'],
    'userId'
  );

  return json(await getBanContentPreview(userId));
};
