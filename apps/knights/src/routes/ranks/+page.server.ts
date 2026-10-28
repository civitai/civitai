import { db } from '$lib/server/db';
import { getPlayerStatusOrNew } from '$lib/server/player-status';
import { PROGRESSION, RATING } from '$lib/server/progression/config';
import { rankTable } from '$lib/server/progression/rating';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => ({
  status: await getPlayerStatusOrNew(db, locals.user.id),
  ranks: rankTable(),
  rules: {
    window: PROGRESSION.fervorWindow,
    minGraded: RATING.minGraded,
    belowBarFactor: RATING.belowBarFactor,
  },
});
