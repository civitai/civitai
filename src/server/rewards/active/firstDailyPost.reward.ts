import { clickhouse } from '~/server/clickhouse/client';
import { createBuzzEvent } from '../base.reward';

export const firstDailyPostReward = createBuzzEvent({
  type: 'firstDailyPost',
  toAccountType: 'blue',
  description: 'You made your first post of the day',
  triggerDescription: 'For the first image post you make each day',
  awardAmount: 25,
  cap: 25,
  onDemand: true,
  getKey: async (input: PostEvent) => {
    return {
      toUserId: input.posterId,
      forId: input.postId,
      byUserId: input.posterId,
      type: `firstDailyPost`,
    };
  },
});

/**
 * Of the given posts, the ids that have already been granted this reward on some
 * earlier day.
 *
 * The Buzz ledger keys this reward on the post — `firstDailyPost:<postId>-<userId>-<userId>`
 * — and that key never expires, while the grant itself is capped per user per UTC
 * day in Redis. So re-applying to a post on a later day passes the daily cap,
 * spends it, and is then refused by the ledger as a duplicate: the user's day is
 * burned and no Buzz moves, silently. Any caller that can hand the reward a post
 * it already paid for has to filter with this first.
 */
export async function getFirstDailyPostRewardedIds(posts: PostOwner[]) {
  const rewarded = new Set<number>();
  if (!clickhouse || !posts.length) return rewarded;

  // Matched on (toUserId, forId), not forId alone: buzzEvents is ordered by
  // (type, toUserId, forId, byUserId), so dropping the user costs the index and
  // turns this into a full read of every firstDailyPost row ever written.
  const pairs = posts.map(({ id, userId }) => `(${userId},${id})`).join(',');
  const rows = await clickhouse.$query<{ forId: number }>`
    SELECT DISTINCT forId
    FROM buzzEvents
    WHERE type = 'firstDailyPost'
      AND status = 'awarded'
      AND (toUserId, forId) IN (${pairs})
  `;
  for (const { forId } of rows) rewarded.add(forId);

  return rewarded;
}

type PostEvent = {
  postId: number;
  posterId: number;
};

type PostOwner = {
  id: number;
  userId: number;
};
