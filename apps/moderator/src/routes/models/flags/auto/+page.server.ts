import type { Actions, PageServerLoad } from './$types';
import { canViewTrainingData } from '$lib/server/access';
import { flaggedActions, loadFlaggedQueue } from '$lib/server/minor-flag-queue';

export const load: PageServerLoad = async ({ url, locals }) => ({
  ...(await loadFlaggedQueue(url)),
  canViewTrainingData: canViewTrainingData(locals.user),
});

export const actions: Actions = flaggedActions;
