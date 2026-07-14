import type { PageServerLoad } from './$types';
import { getContentTotals } from '$lib/server/analytics';

// The earnings summary (ClickHouse owner-keyed rollup, decision A1) lands here later. For now we surface the
// creator's content activity (userId-keyed, no A1 needed); the layout load already resolved user + membership.
export const load: PageServerLoad = async ({ locals }) => {
  try {
    const content = await getContentTotals(locals.user.id, 30);
    return { content };
  } catch {
    return { content: null };
  }
};
