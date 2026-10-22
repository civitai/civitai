import type { Actions, PageServerLoad } from './$types';
import {
  ratingDisputeTriageLoad,
  resolveRatingDisputeAction,
} from '$lib/server/rating-dispute-queue';

export const load: PageServerLoad = ({ url }) => ratingDisputeTriageLoad(url);

export const actions: Actions = { resolve: resolveRatingDisputeAction };
