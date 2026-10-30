import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// /articles is the Articles group path (gating + icon + nav parent), not a page itself — its queue lives at
// /articles/unpublished. Send the bare path (and the legacy /moderator/articles
// redirect that lands here) to the unpublished queue.
export const load: PageServerLoad = () => {
  redirect(307, '/articles/unpublished');
};
