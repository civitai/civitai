import type { PageServerLoad } from './$types';
import { getContentTotals } from '$lib/server/analytics';
import { getEarningsSummary } from '$lib/server/earnings';
import { getModelEarnings } from '$lib/server/models-earnings';
import { getCreatorCash } from '$lib/server/cash';
import { presetRange, previousRange } from '$lib/date-range';

// Headline content activity (userId-keyed ClickHouse) + buzz earnings (A1 Part 1, buzzTransactions) + cash
// balances (buzz service — authoritative, matches the Buzz dashboard) + top-earning model (A1 Part 2, the
// owner-stamped resourceCompensations). Each degrades independently so one slow or failed source doesn't blank the
// others. `*Prev` = the previous 30 days, for the period-over-period delta chips. Layout resolved user + membership.
export const load: PageServerLoad = async ({ locals }) => {
  const userId = locals.user.id;
  const range = presetRange(30);
  const prev = previousRange(range);
  const [content, contentPrev, earnings, earningsPrev, cash, topModels] = await Promise.all([
    getContentTotals({ userId, ...range }).catch(() => null),
    getContentTotals({ userId, ...prev }).catch(() => null),
    getEarningsSummary({ userId, ...range }).catch(() => null),
    getEarningsSummary({ userId, ...prev }).catch(() => null),
    getCreatorCash({ userId }).catch(() => null),
    getModelEarnings({ userId, ...range }).catch(() => null),
  ]);
  return { content, contentPrev, earnings, earningsPrev, cash, topModels };
};
