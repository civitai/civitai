import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The bare route has no sweep of its own. Images is the entry point: it is the larger population and
// the one a moderator arriving without a link is usually working. Query is carried across so an
// existing `?level=`/`?order=` link keeps meaning what it did before the tabs.
export const load: PageServerLoad = async ({ url }) => {
  const qs = url.searchParams.toString();
  redirect(307, `/retool/front-page-audit/image${qs ? `?${qs}` : ''}`);
};
