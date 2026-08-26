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
  // 🔴 Decided HERE, not in the panel. User Lookup is granted more widely than /abuse, so an
  // unentitled moderator legitimately reaches this page — and having the panel mount and interpret
  // a 403 put a one-line mutation between them and "No detector has ever reported this account",
  // i.e. a permission boundary rendered as a clean record. Deciding server-side means there is no
  // client branch to get that wrong. The endpoint re-checks regardless, like every action here.
  const canSeeAbuse = canAccess(locals.user, '/abuse');
  // Full content width: the panels are multi-column and data-dense (Buzz shows the transaction form
  // and the history together), and the 6xl cap forced them into a single narrow stack.
  const base = { q, canAct, canSeeAbuse, wide: true };
  if (!q) return { ...base, result: null, notFound: false };

  const userId = await resolveUserId(q);
  if (!userId) return { ...base, result: null, notFound: true };

  return { ...base, result: await getUserLookup(userId), notFound: false };
};
