import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Bare /scanner-audit → the text mode landing (mods switch modes via the tab chrome).
export const load: PageServerLoad = () => {
  redirect(307, '/scanner-audit/text');
};
