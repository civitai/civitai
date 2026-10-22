import type { Actions, PageServerLoad } from './$types';
import { scamBulkRule, scamReviewLoad } from '$lib/server/scam-review';

export const load: PageServerLoad = ({ url, locals }) =>
  scamReviewLoad(url).then((data) => ({
    ...data,
    canBan: !!locals.grants['audit.ban.execute'],
  }));

export const actions: Actions = { rule: scamBulkRule };
