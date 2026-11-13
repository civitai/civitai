import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { GENERATOR_RESTRICTION_TYPES, RESTRICTION_TYPE } from '$lib/restriction-types';
import { restrictionActions, restrictionTriageLoad } from '$lib/server/restriction-queue';
import { getGenerationRestrictions, recheckTriggers } from '$lib/server/user-restriction.service';

// `?type=scam` is redirected to the Users page in hooks.server.ts, ahead of this page's grant.
export const load: PageServerLoad = ({ url }) =>
  restrictionTriageLoad(url, {
    types: GENERATOR_RESTRICTION_TYPES,
    fallback: RESTRICTION_TYPE,
  });

export const actions: Actions = {
  ...restrictionActions(GENERATOR_RESTRICTION_TYPES),

  // Fetched when a restriction is opened rather than in `load`: selection is client state, so `load`
  // does not run again, and re-checking all 50 rows of a page up front would be the page's heaviest read.
  recheck: async ({ request }) => {
    const id = z.coerce
      .number()
      .int()
      .positive()
      .safeParse((await request.formData()).get('userRestrictionId'));
    if (!id.success) return fail(400, { error: 'Missing restriction id.' });

    // `any`, as the other by-id actions do: the id is a primary key and the type is checked below.
    const { items } = await getGenerationRestrictions({
      page: 1,
      limit: 1,
      type: 'any',
      restrictionId: id.data,
    });
    const row = items[0];
    if (!row || !(GENERATOR_RESTRICTION_TYPES as readonly string[]).includes(row.type))
      return fail(404, { error: 'Restriction not found.' });

    return { recheck: recheckTriggers(row.triggers) };
  },
};
