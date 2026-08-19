import type { LayoutServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { lookupQuerySchema, parseQuery } from '$lib/server/query';
import { getUserLookup, resolveUserId } from '$lib/server/user-lookup.service';

// The lookup itself lives in the LAYOUT so it survives moving between sections: switching from Buzz
// to Reports must not re-resolve the account or lose the search term.
export const load: LayoutServerLoad = async ({ url, locals }) => {
  const { q } = parseQuery(url, lookupQuerySchema);
  // `canAct` gates the enforcement UI; the actions re-check it server-side regardless.
  const canAct = canAccess(locals.user, '/users');
  // Full content width: the panels are multi-column and data-dense (Buzz shows the transaction form
  // and the history together), and the 6xl cap forced them into a single narrow stack.
  const base = { q, canAct, wide: true };
  if (!q) return { ...base, result: null, notFound: false };

  const userId = await resolveUserId(q);
  if (!userId) return { ...base, result: null, notFound: true };

  return { ...base, result: await getUserLookup(userId), notFound: false };
};
