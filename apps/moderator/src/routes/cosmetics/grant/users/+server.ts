import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchUsers } from '$lib/server/users.service';

// Typeahead for the grant page's user picker. Access is enforced globally (hooks.server.ts):
// this route id is under /cosmetics/grant, so only moderators with that nav entry reach it.
export const GET: RequestHandler = async ({ url }) => {
  const q = url.searchParams.get('q') ?? '';
  return json(await searchUsers({ query: q, limit: 10 }));
};
