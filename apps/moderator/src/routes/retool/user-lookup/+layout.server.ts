import { z } from 'zod';
import type { LayoutServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { parseQuery } from '$lib/server/query';
import { getUserLookup, resolveUserId } from '$lib/server/user-lookup.service';

const querySchema = z.object({ q: z.string().trim().catch('') });

// The lookup itself lives in the LAYOUT so it survives moving between sections: switching from Buzz
// to Reports must not re-resolve the account or lose the search term.
export const load: LayoutServerLoad = async ({ url, locals }) => {
  const { q } = parseQuery(url, querySchema);
  // `canAct` gates the enforcement UI; the actions re-check it server-side regardless.
  const canAct = canAccess(locals.user, '/users');
  if (!q) return { q, canAct, result: null, notFound: false };

  const userId = await resolveUserId(q);
  if (!userId) return { q, canAct, result: null, notFound: true };

  return { q, canAct, result: await getUserLookup(userId), notFound: false };
};
