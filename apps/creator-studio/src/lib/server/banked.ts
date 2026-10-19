import { getBuzz } from '$lib/server/buzz';
import { createCache } from '$lib/server/cache';
import { BANKABLE_CURRENCIES } from '$lib/buzz-currency-filter';

// Buzz banked into the Creator Program this month, summed over the bankable currencies — the main app's
// getBankedBalance (fetchBankedPerType) read the same way. Each month's bank is its own `creatorProgramBank`
// account keyed YYYYMM, and the creator's net deposit is that account's counterparty balance with them.
// Buzz, not cash cents.

/** The bank account id for the month containing `now`, read in UTC so it doesn't depend on the server's zone. */
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
