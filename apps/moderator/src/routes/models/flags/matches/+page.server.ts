import type { Actions, PageServerLoad } from './$types';
import { loadMinorQueue, minorHashActions } from '$lib/server/minor-flag-queue';

// Pending only: the auto-flagged rows have no page until they move to the Flagged tab.
export const load: PageServerLoad = ({ url }) => loadMinorQueue(url, 'pending', null);

export const actions: Actions = minorHashActions;
