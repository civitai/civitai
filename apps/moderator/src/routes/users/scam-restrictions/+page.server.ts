import type { Actions, PageServerLoad } from './$types';
import { restrictionActions, restrictionQueueLoad } from '$lib/server/restriction-queue';

export const load: PageServerLoad = ({ url }) =>
  restrictionQueueLoad(url, { types: ['scam'], fallback: 'scam' });

export const actions: Actions = restrictionActions(['scam']);
