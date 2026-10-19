import type { Actions, PageServerLoad } from './$types';
import { withSplitDecisions } from '$lib/minor-flags/appeal-split';
import { appealActions, loadAppealQueue } from '$lib/server/minor-flag-queue';

export const load: PageServerLoad = ({ url }) => loadAppealQueue(url);

export const actions: Actions = {
  ...appealActions,
  splitAppeal: async (event) => {
    const body = withSplitDecisions(await event.request.formData());
    const request = new Request(event.request.url, { method: 'POST', body });
    return appealActions.splitAppeal({ ...event, request });
  },
};
