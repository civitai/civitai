import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { heldGridCount } from '@civitai/shared/held-media';
import { requireAccess } from '$lib/server/access';
import { HELD_MEDIA_PAGE, recordHeldGridView } from '$lib/server/held-media';

// Sent by the grid once it renders, rather than recorded in the page load, which also runs for a
// hover preload of a page nobody opens.
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) error(403, 'Not signed in.');
  requireAccess(locals.user, HELD_MEDIA_PAGE);
  const count = heldGridCount(await request.json().catch(() => null));
  if (count == null) error(400, 'Bad count.');
  recordHeldGridView(locals.user.id, count);
  return new Response(null, { status: 204 });
};
