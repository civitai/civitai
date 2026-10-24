import type { PageServerLoad } from './$types';
import {
  getContentAnalytics,
  getAllTimeTotals,
  getReactionAudienceSplit,
} from '$lib/server/analytics';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';
import { getFollowerReach } from '$lib/server/follower-reach';
import { presentReach, type FollowerReachResult } from '$lib/analytics/follower-reach';

export const load: PageServerLoad = async ({ locals, cookies }) => {
  const { range, compare } = readAnalyticsPeriod(cookies);
  const prev = compare.range;
  const userId = locals.user.id;
  const [analytics, analyticsPrev, allTime, reactionSplit, followerReach] = await Promise.all([
    getContentAnalytics({ userId, ...range }).catch(() => null),
    getContentAnalytics({ userId, ...prev }).catch(() => null),
    getAllTimeTotals({ userId }).catch(() => null),
    getReactionAudienceSplit({ userId, ...range }).catch(() => null),
    getFollowerReach({ userId })
      .then(presentReach)
      .catch((): FollowerReachResult => ({ status: 'unavailable' })),
  ]);
  return { analytics, analyticsPrev, allTime, reactionSplit, followerReach };
};
