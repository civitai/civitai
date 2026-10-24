import type { Actions, PageServerLoad } from './$types';
import { withSplitDecisions } from '$lib/minor-flags/appeal-split';
import { canViewTrainingData } from '$lib/server/access';
import { appealActions, loadAppealQueue } from '$lib/server/minor-flag-queue';

export const load: PageServerLoad = async ({ url, locals }) => ({
  ...(await loadAppealQueue(url)),
  canViewTrainingData: canViewTrainingData(locals.user),
});

export const actions: Actions = {
  ...appealActions,
  splitAppeal: async (event) => {
    const body = withSplitDecisions(await event.request.formData());
    const request = new Request(event.request.url, { method: 'POST', body });
    return appealActions.splitAppeal({ ...event, request });
  },
};
