import type { Actions, PageServerLoad } from './$types';
import {
  ratingDisputeTriageLoad,
  resolveRatingDisputeAction,
} from '$lib/server/rating-dispute-queue';

export const load: PageServerLoad = ({ url, locals }) => ratingDisputeTriageLoad(url, locals.user);

export const actions: Actions = { resolve: resolveRatingDisputeAction };
