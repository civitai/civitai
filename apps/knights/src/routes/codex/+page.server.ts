import { db } from '$lib/server/db';
import { ladderRows } from '$lib/server/ladder';
import { getPlayerStatusOrNew } from '$lib/server/player-status';
import { rankTable } from '$lib/server/progression/rating';
import { rankBadgeUrls } from '$lib/server/rank-badges';
import { rulesFacts } from '$lib/server/rules';
import { fervorSum } from '$lib/server/leaderboard-view';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const days = new Map(ladderRows().map((row) => [row.rank, row.minDaysPlayed]));
  const [status, badges, player] = await Promise.all([
    getPlayerStatusOrNew(db, locals.user.id),
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
    ranks: rankTable().map(({ voteWeight: _voteWeight, ...rank }) => {
      const minDaysPlayed = days.get(rank.rank);
      return minDaysPlayed ? { ...rank, minDaysPlayed } : rank;
    }),
    facts: rulesFacts(),
    fervorExample: { correct: 100, accuracyPercent: 80, sum: fervorSum(100, 125) },
    badges: badges.large,
    swornIn: player?.startAt.toISOString() ?? null,
  };
};
