import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import {
  getAvailableBadges,
  getBounties,
  getBountyEntries,
  getShopPurchases,
  getBuzzBalance,
  getComments,
  getCommentsV2,
  getCosmetics,
  getReactionTargets,
  getReceivedReviews,
  getResourceGenerations,
  getReviews,
  getTrainingRuns,
  getUserNotifications,
} from '$lib/server/user-account.service';
import { softly } from '$lib/server/user-signals.service';

// Client-fetched: the Buzz balance is an external HTTP call and the lists are only wanted once an
// investigation is already underway. Keeping them off the load means identity still renders immediately.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');

  const [
    buzz,
    reviews,
    receivedReviews,
    comments,
    commentsV2,
    cosmetics,
    reactions,
    trainings,
    bounties,
    bountyEntries,
    notifications,
    resourceGenerations,
    shopPurchases,
    availableBadges,
  ] = await Promise.all([
    getBuzzBalance(userId),
    getReviews(userId),
    getReceivedReviews(userId),
    getComments(userId),
    getCommentsV2(userId),
    getCosmetics(userId),
    getReactionTargets(userId),
    getTrainingRuns(userId),
    getBounties(userId),
    getBountyEntries(userId),
    getUserNotifications(userId),
    // The only ClickHouse read on this endpoint. Left unguarded it took Reviews, Comments, Bounties
    // and Cosmetics down with it, none of which touch ClickHouse.
    softly('resourceGenerations', () => getResourceGenerations(userId), []),
    getShopPurchases(userId),
    getAvailableBadges(userId),
  ]);

  return json({
    buzz,
    reviews,
    receivedReviews,
    comments,
    commentsV2,
    cosmetics,
    reactions,
    trainings,
    bounties,
    bountyEntries,
    notifications,
    resourceGenerations,
    shopPurchases,
    availableBadges,
  });
};
