import type { Actions, PageServerLoad } from './$types';
import { appealActions, loadMinorQueue } from '$lib/server/minor-flag-queue';

export const load: PageServerLoad = ({ url }) => loadMinorQueue(url, 'appeals', null);

export const actions: Actions = appealActions;
