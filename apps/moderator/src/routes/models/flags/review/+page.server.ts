import type { Actions, PageServerLoad } from './$types';
import { flaggedActions, loadFlaggedQueue } from '$lib/server/minor-flag-queue';

export const load: PageServerLoad = ({ url }) => loadFlaggedQueue(url);

export const actions: Actions = flaggedActions;
