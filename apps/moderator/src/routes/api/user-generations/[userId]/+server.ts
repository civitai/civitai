import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { getResourceGenerations } from '$lib/server/user-account.service';

// Split out of /api/user-account so the look-back window can be changed without refetching the other
// thirteen queries in that bundle — and so this app's only ClickHouse read fails on its own. Bundled, it
// took Reviews, Comments, Bounties and Cosmetics down with it whenever ClickHouse was unhappy, which is
// why it needed a `softly` wrapper there.
export const GET: RequestHandler = async ({ params, url, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');

  // Clamped rather than trusted: `days` is interpolated into the ClickHouse query, not bound.
  const requested = Number(url.searchParams.get('days'));
  const days = Number.isInteger(requested) && requested > 0 && requested <= 365 ? requested : 30;

  return json(await getResourceGenerations(userId, days));
};
