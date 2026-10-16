import type { Actions, PageServerLoad } from './$types';
import { loadRedetectedQueue, redetectionActions } from '$lib/server/minor-flag-queue';

export const load: PageServerLoad = ({ url }) => loadRedetectedQueue(url);

export const actions: Actions = redetectionActions;
