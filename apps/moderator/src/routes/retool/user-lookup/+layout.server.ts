import type { LayoutServerLoad } from './$types';
import { canAccess, isSenior } from '$lib/server/access';
import { lookupQuerySchema, parseQuery } from '$lib/server/query';
import { getUserLookup, resolveUserId } from '$lib/server/user-lookup.service';

// The lookup itself lives in the LAYOUT so it survives moving between sections: switching from Buzz
// to Reports must not re-resolve the account or lose the search term.
export const load: LayoutServerLoad = async ({ url, locals }) => {
  const { q } = parseQuery(url, lookupQuerySchema);
  // `canAct` gates the enforcement UI; the actions re-check it server-side regardless.
  const canAct = canAccess(locals.user, '/users');
  // Buzz sending was Senior-Mod-gated in Retool; the action re-checks this regardless.
  const canSendBuzz = canAct && isSenior(locals.user);
  if (!q) return { q, canAct, canSendBuzz, result: null, notFound: false };

  const userId = await resolveUserId(q);
  if (!userId) return { q, canAct, canSendBuzz, result: null, notFound: true };

  return { q, canAct, canSendBuzz, result: await getUserLookup(userId), notFound: false };
};
