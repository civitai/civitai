import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import {
  getAvailableBadges,
  getBounties,
  getBountyEntries,
  getShopPurchases,
  getComments,
  getCommentsV2,
  getCosmetics,
  getReactionTargets,
  getReceivedReviews,
  getReviews,
  getTrainingRuns,
} from '$lib/server/user-account.service';

// Client-fetched: these lists are only wanted once an investigation is already underway, so keeping
// them off the load means identity still renders immediately. Every panel fed by this waits on the
// slowest member — `getReactionTargets`, an aggregate over 744M rows.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');

  const [
    reviews,
    receivedReviews,
    comments,
    commentsV2,
    cosmetics,
    reactions,
    trainings,
    bounties,
    bountyEntries,
    shopPurchases,
    availableBadges,
  ] = await Promise.all([
    getReviews(userId),
    getReceivedReviews(userId),
    getComments(userId),
    getCommentsV2(userId),
    getCosmetics(userId),
    getReactionTargets(userId),
    getTrainingRuns(userId),
    getBounties(userId),
    getBountyEntries(userId),
    getShopPurchases(userId),
    getAvailableBadges(userId),
  ]);

  return json({
    reviews,
    receivedReviews,
    comments,
    commentsV2,
    cosmetics,
    reactions,
    trainings,
    bounties,
    bountyEntries,
    shopPurchases,
    availableBadges,
  });
};
