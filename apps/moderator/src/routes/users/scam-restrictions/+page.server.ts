import type { Actions, PageServerLoad } from './$types';
import { restrictionActions, restrictionTriageLoad } from '$lib/server/restriction-queue';

export const load: PageServerLoad = ({ url }) =>
  restrictionTriageLoad(url, { types: ['scam'], fallback: 'scam' });

export const actions: Actions = restrictionActions(['scam']);
