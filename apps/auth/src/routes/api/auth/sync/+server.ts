import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSigner } from '$lib/server/auth/session';

// Cross-root swap: a different-root spoke (civitai.red) fetches this with credentials to pull
// a short-lived signed swap token for the logged-in user, then exchanges it for a local
// session via the `account-switch` receiver. Replaces the old AES civ-token /api/auth/sync.
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) error(401, 'Not authenticated');
  const swapToken = await getSigner().mintSwapToken(locals.user.id);
  return json({ swapToken, userId: locals.user.id, username: locals.user.username });
};
