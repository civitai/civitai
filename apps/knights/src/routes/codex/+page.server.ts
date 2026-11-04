import { db } from '$lib/server/db';
import { ladderRows } from '$lib/server/ladder';
import { getPlayerStatusOrNew } from '$lib/server/player-status';
import { rankTable } from '$lib/server/progression/rating';
import { rankBadgeUrls } from '$lib/server/rank-badges';
import { rulesFacts } from '$lib/server/rules';
import { judgesNeeded } from '$lib/server/yesno/items';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const days = new Map(ladderRows().map((row) => [row.rank, row.minDaysPlayed]));
  const [status, judges, badges, player] = await Promise.all([
    getPlayerStatusOrNew(db, locals.user.id),
    judgesNeeded(db),
    rankBadgeUrls(db),
    db
      .selectFrom('NewOrderPlayer')
      .select('startAt')
      .where('userId', '=', locals.user.id)
      .executeTakeFirst(),
  ]);
  return {
    status,
    // Level bands, bars and day requirements all come from config; `minDaysPlayed` is present only on a rank that has it.
    ranks: rankTable().map((rank) => {
      const minDaysPlayed = days.get(rank.rank);
      return minDaysPlayed ? { ...rank, minDaysPlayed } : rank;
    }),
    facts: rulesFacts(judges),
    badges: badges.large,
    swornIn: player?.startAt.toISOString() ?? null,
  };
};
