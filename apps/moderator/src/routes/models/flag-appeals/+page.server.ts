import type { Actions, PageServerLoad } from './$types';
import { appealActions, loadFlagQueue } from '$lib/server/minor-flag-queue';

export const load: PageServerLoad = ({ url }) => loadFlagQueue(url);

export const actions: Actions = appealActions;
