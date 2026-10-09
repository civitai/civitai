import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canSeeUserCard } from '$lib/server/user-card';
import { getUserCard, resolveUserId } from '$lib/server/user-lookup.service';

// `?q=` rather than a `[userId]` param: it serves the popover on every link to User Lookup, and many
// of those links carry a username, not an id.
export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) error(403, 'Not signed in.');
  if (!canSeeUserCard(locals)) error(403, 'You do not have access to this page.');

  const q = url.searchParams.get('q')?.trim() ?? '';
  if (!q || q.length > 100) error(400, 'Bad q.');

  const userId = await resolveUserId(q);
  const card = userId ? await getUserCard(userId) : null;
  if (!card) error(404, 'No such user.');
  return json(card);
};
