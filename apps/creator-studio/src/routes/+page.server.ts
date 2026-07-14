import type { PageServerLoad } from './$types';
import { getContentTotals } from '$lib/server/analytics';
import { getEarningsSummary } from '$lib/server/earnings';
import { getCreatorCash } from '$lib/server/cash';

// Headline content activity (userId-keyed ClickHouse) + buzz earnings (A1 Part 1, buzzTransactions) + cash
// balances (buzz service — authoritative, matches the Buzz dashboard). Each degrades independently so one slow or
// failed source doesn't blank the others. Layout resolved user + membership. "Top-earning model" waits on A1 Part 2.
export const load: PageServerLoad = async ({ locals }) => {
  const userId = locals.user.id;
  const [content, earnings, cash] = await Promise.all([
    getContentTotals({ userId, days: 30 }).catch(() => null),
    getEarningsSummary({ userId, days: 30 }).catch(() => null),
    getCreatorCash({ userId }).catch(() => null),
  ]);
  return { content, earnings, cash };
};
