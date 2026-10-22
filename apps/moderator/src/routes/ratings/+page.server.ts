import type { Actions, PageServerLoad } from './$types';
import {
  ratingDisputeTriageLoad,
  resolveRatingDisputeAction,
} from '$lib/server/rating-dispute-queue';

// Access is enforced globally (hooks.server.ts); the per-entity level rule is enforced in the service.
export const load: PageServerLoad = ({ url }) => ratingDisputeTriageLoad(url);

export const actions: Actions = { resolve: resolveRatingDisputeAction };
