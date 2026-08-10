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
  // Senior gates the capabilities Retool restricted with a pane-level `only visible when`: sending
  // buzz, and promoting or demoting a moderator. Every action re-checks it regardless.
  const senior = canAct && isSenior(locals.user);
  const base = { q, canAct, canSendBuzz: senior, isSenior: senior };
  if (!q) return { ...base, result: null, notFound: false };

  const userId = await resolveUserId(q);
  if (!userId) return { ...base, result: null, notFound: true };

  return { ...base, result: await getUserLookup(userId), notFound: false };
};
