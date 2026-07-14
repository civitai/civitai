import type { PageServerLoad } from './$types';
import { getContentTotals } from '$lib/server/analytics';
import { getEarningsSummary } from '$lib/server/earnings';

// Headline content activity (userId-keyed) + earnings summary (A1 Part 1, buzzTransactions — already owner-keyed).
// Each degrades independently so one slow/failed ClickHouse read doesn't blank the other. Layout resolved user +
// membership. Per-model "top-earning model" still waits on A1 Part 2.
export const load: PageServerLoad = async ({ locals }) => {
  const [content, earnings] = await Promise.all([
    getContentTotals({ userId: locals.user.id, days: 30 }).catch(() => null),
    getEarningsSummary({ userId: locals.user.id, days: 30 }).catch(() => null),
  ]);
  return { content, earnings };
};
