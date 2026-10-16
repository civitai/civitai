import type { Actions, PageServerLoad } from './$types';
import { loadMatchesQueue, matchesActions } from '$lib/server/minor-flag-queue';

export const load: PageServerLoad = ({ url }) => loadMatchesQueue(url);

export const actions: Actions = matchesActions;
