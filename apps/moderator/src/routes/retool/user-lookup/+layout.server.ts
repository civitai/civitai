import type { LayoutServerLoad } from './$types';
import { CAPABILITIES, canAccess, canUse } from '$lib/server/access';
import { lookupQuerySchema, parseQuery } from '$lib/server/query';
import { getUserLookup, resolveUserId } from '$lib/server/user-lookup.service';

// The lookup itself lives in the LAYOUT so it survives moving between sections: switching from Buzz
// to Reports must not re-resolve the account or lose the search term.
export const load: LayoutServerLoad = async ({ url, locals }) => {
  const { q } = parseQuery(url, lookupQuerySchema);
  // `canAct` gates the enforcement UI; the actions re-check it server-side regardless.
  const canAct = canAccess(locals.user, '/users');
  // The capabilities Retool restricted with a pane-level `only visible when`, now one grant each. These
  // decide what renders; every action re-checks its own regardless. `canUse` carries the `/users`
  // requirement itself, so there is nothing to AND in here.
  // Full content width: the panels are multi-column and data-dense (Buzz shows the transaction form
  // and the history together), and the 6xl cap forced them into a single narrow stack.
  const base = {
    q,
    canAct,
    canSendBuzz: canUse(locals.user, CAPABILITIES.sendBuzz),
    canEditIdentity: canUse(locals.user, CAPABILITIES.editIdentity),
    canToggleModerator: canUse(locals.user, CAPABILITIES.toggleModerator),
    canGrantCosmetics: canUse(locals.user, CAPABILITIES.grantCosmetics),
    wide: true,
  };
  if (!q) return { ...base, result: null, notFound: false };

  const userId = await resolveUserId(q);
  if (!userId) return { ...base, result: null, notFound: true };

  return { ...base, result: await getUserLookup(userId), notFound: false };
};
