import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { parseQuery } from '$lib/server/query';
import { recordModActivity } from '$lib/server/mod-activity';
import {
  findTakedownHash,
  getTakedownHashCandidates,
  recordTakedownHashes,
} from '$lib/server/takedown-hashes.service';

const querySchema = z.object({ q: z.string().trim().catch('') });

export const load: PageServerLoad = async ({ url, locals }) => {
  const { q } = parseQuery(url, querySchema);

  const [candidates, matches] = await Promise.all([
    getTakedownHashCandidates(),
    q ? findTakedownHash(q) : Promise.resolve([]),
  ]);

  return {
    q,
    matches,
    candidateCount: candidates.length,
    canAct: canAccess(locals.user, '/retool/takedown-hashes'),
  };
};

export const actions: Actions = {
  record: async ({ locals }) => {
    if (!canAccess(locals.user, '/retool/takedown-hashes'))
      return fail(403, { error: 'Not permitted.' });

    const { found, added, more } = await recordTakedownHashes();
    if (added === 0)
      return fail(400, {
        error: `Nothing new — all ${found} candidate hashes are already recorded.`,
      });

    // The ledger has no column for who wrote a row, so this is the only attribution there is.
    await recordModActivity({
      userId: locals.user.id,
      entityType: 'takedownHashes',
      entityId: 0,
      activity: 'recordHashes',
    });

    return { success: true, added, found, more };
  },
};
