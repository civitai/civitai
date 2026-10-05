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
  getReceivedReviews,
  getReviews,
  getTrainingRuns,
} from '$lib/server/user-account.service';

// Client-fetched: these lists are only wanted once an investigation is already underway, so keeping
// them off the load means identity still renders immediately.
//
// Everything here resolves in about a second. Two things that did not have their own endpoints — the
// Buzz balance and the reaction aggregate — because a `Promise.all` is only as fast as its slowest
// member, and both were slow enough to make every other panel look broken.
export const GET: RequestHandler = async ({ params, locals }) => {
  const userId = requireUserIdParam(locals, params, '/retool/user-lookup');

  const [
    reviews,
    receivedReviews,
    comments,
    commentsV2,
    cosmetics,
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
    trainings,
    bounties,
    bountyEntries,
    shopPurchases,
    availableBadges,
  });
};
