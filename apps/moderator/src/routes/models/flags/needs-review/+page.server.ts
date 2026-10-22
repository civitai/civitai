import type { Actions, PageServerLoad } from './$types';
import { loadNeedsReviewQueue, needsReviewActions } from '$lib/server/minor-flag-queue';

export const load: PageServerLoad = ({ url, locals }) => loadNeedsReviewQueue(url, locals.grants);

export const actions: Actions = needsReviewActions;
