import type { Actions, PageServerLoad } from './$types';
import { canViewTrainingData } from '$lib/server/access';
import { loadNeedsReviewQueue, needsReviewActions } from '$lib/server/minor-flag-queue';

export const load: PageServerLoad = async ({ url, locals }) => ({
  ...(await loadNeedsReviewQueue(url, locals.grants)),
  canViewTrainingData: canViewTrainingData(locals.user),
});

export const actions: Actions = needsReviewActions;
