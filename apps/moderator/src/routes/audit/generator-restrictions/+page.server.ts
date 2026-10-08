import type { Actions, PageServerLoad } from './$types';
import { GENERATOR_RESTRICTION_TYPES, RESTRICTION_TYPE } from '$lib/restriction-types';
import { restrictionActions, restrictionQueueLoad } from '$lib/server/restriction-queue';

// `?type=scam` is redirected to the Users page in hooks.server.ts, ahead of this page's grant.
export const load: PageServerLoad = ({ url }) =>
  restrictionQueueLoad(url, {
    types: GENERATOR_RESTRICTION_TYPES,
    fallback: RESTRICTION_TYPE,
  });

export const actions: Actions = restrictionActions(GENERATOR_RESTRICTION_TYPES);
