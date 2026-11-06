import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireUserIdParam } from '$lib/server/api-guard';
import { listGrantableBoxes } from '$lib/server/mystery-box-builder.service';
import {
  getAvailableBadges,
  getBounties,
  getBountyEntries,
  getShopPurchases,
  getComments,
  getCommentsV2,
  getCosmetics,
  getGrantedBoxes,
  getReceivedReviews,
  getTrainingRuns,
} from '$lib/server/user-account.service';

// Client-fetched: these lists are only wanted once an investigation is already underway, so keeping
// them off the load means identity still renders immediately.
//
// Every member of the Promise.all must be fast: the bundle is as slow as its slowest. The Buzz balance,
// the reaction aggregate, the written-review list and its image counts each have their own endpoint
// for that reason.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');

  const [
    receivedReviews,
    comments,
    commentsV2,
    cosmetics,
    trainings,
    bounties,
    bountyEntries,
    shopPurchases,
    availableBadges,
    grantedBoxes,
    grantableBoxes,
  ] = await Promise.all([
    getReceivedReviews(userId),
    getComments(userId),
    getCommentsV2(userId),
    getCosmetics(userId),
    getTrainingRuns(userId),
    getBounties(userId),
    getBountyEntries(userId),
    getShopPurchases(userId),
    getAvailableBadges(userId),
    getGrantedBoxes(userId),
    listGrantableBoxes(),
  ]);

  return json({
    receivedReviews,
    comments,
    commentsV2,
    cosmetics,
    trainings,
    bounties,
    bountyEntries,
    shopPurchases,
    availableBadges,
    grantedBoxes,
    grantableBoxes,
  });
};
