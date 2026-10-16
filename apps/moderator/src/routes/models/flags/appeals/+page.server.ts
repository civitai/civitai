import type { Actions, PageServerLoad } from './$types';
import { appealActions, loadAppealQueue } from '$lib/server/minor-flag-queue';

export const load: PageServerLoad = ({ url }) => loadAppealQueue(url);

export const actions: Actions = appealActions;
