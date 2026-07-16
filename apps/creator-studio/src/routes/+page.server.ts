import type { PageServerLoad } from './$types';
import { getContentTotals } from '$lib/server/analytics';
import { getEarningsSummary } from '$lib/server/earnings';
import { getModelEarnings } from '$lib/server/models-earnings';
import { getCreatorCash } from '$lib/server/cash';
import { presetRange } from '$lib/date-range';

// Headline content activity (userId-keyed ClickHouse) + buzz earnings (A1 Part 1, buzzTransactions) + cash
// balances (buzz service — authoritative, matches the Buzz dashboard) + top-earning model (A1 Part 2, the
// owner-stamped resourceCompensations). Each degrades independently so one slow or failed source doesn't blank the
// others. Layout resolved user + membership.
export const load: PageServerLoad = async ({ locals }) => {
  const userId = locals.user.id;
  const [content, earnings, cash, topModels] = await Promise.all([
    getContentTotals({ userId, ...presetRange(30) }).catch(() => null),
    getEarningsSummary({ userId, ...presetRange(30) }).catch(() => null),
    getCreatorCash({ userId }).catch(() => null),
    getModelEarnings({ userId, ...presetRange(30) }).catch(() => null),
  ]);
  return { content, earnings, cash, topModels };
};
