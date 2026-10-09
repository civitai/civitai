import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// /bounties is the Bounties group path (gating + nav parent), not a page itself.
export const load: PageServerLoad = () => {
  redirect(307, '/bounties/poi-appeals');
};
