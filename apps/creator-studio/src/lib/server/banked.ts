import { getBuzz } from '$lib/server/buzz';
import { createCache } from '$lib/server/cache';
import { BANKABLE_CURRENCIES } from '$lib/buzz-currency-filter';

// Mirrors main's getBankedBalance (fetchBankedPerType). Each month's bank is a `creatorProgramBank` account keyed
// YYYYMM; the creator's deposit is its counterparty balance with them. Buzz, not cash cents.

/** UTC, so the month doesn't depend on the server's zone (main's getMonthAccount uses local time). */
export function bankMonthAccount(now: Date): number {
  return now.getUTCFullYear() * 100 + now.getUTCMonth() + 1;
}

async function fetchBanked({ userId }: { userId: number }): Promise<number> {
  const buzz = getBuzz();
  const accountId = bankMonthAccount(new Date());
  const totals = await Promise.all(
    BANKABLE_CURRENCIES.map((accountType) =>
      buzz.getCounterparties(accountId, {
        accountType: 'creatorProgramBank',
        query: { accountId: userId, accountType },
      })
    )
  );
  return totals.reduce((sum, t) => sum + (t.totalBalance ?? 0), 0);
}

export const getBanked = createCache({
  name: 'banked',
  fetch: fetchBanked,
  ttlSeconds: 60,
}).get;
