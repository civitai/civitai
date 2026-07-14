import { getBuzz } from '$lib/server/buzz';
import { dbRead } from '$lib/server/db';
import { createCache } from '$lib/server/cache';

// Authoritative Creator Program cash — the same three figures the main app's Buzz dashboard shows, from the same
// sources, so they match to the cent. `settled` (ready to withdraw) + `pending` come from the buzz service (NOT
// ClickHouse — that's a mirror + flow log that drifts). `withdrawn` is the net-of-fees payout total from the
// `CashWithdrawal` table, mirroring the main app's getUserCash query. All values are USD **cents** (cash accounts
// and withdrawals are cents, not buzz), so the UI divides by 100 (see formatAmount / centsToUsd). Cached briefly
// to absorb page-reload bursts.
export type CreatorCash = { settled: number; pending: number; withdrawn: number };

// Statuses that don't count toward withdrawn — mirrors the main app's getUserCash (buzz.service.ts).
const EXCLUDED_WITHDRAWAL_STATUSES = ['Rejected', 'Canceled', 'FailedFee', 'Reclaimed'] as const;

async function fetchCreatorCash({ userId }: { userId: number }): Promise<CreatorCash> {
  const buzz = getBuzz();
  const [settled, pending, withdrawal] = await Promise.all([
    buzz.getUserBuzzByAccountType(userId, 'cashSettled'),
    buzz.getUserBuzzByAccountType(userId, 'cashPending'),
    dbRead
      .selectFrom('CashWithdrawal')
      .where('userId', '=', userId)
      .where('status', 'not in', EXCLUDED_WITHDRAWAL_STATUSES)
      .select((eb) => eb.fn.sum<string | number | null>('amount').as('total'))
      .executeTakeFirst(),
  ]);
  return {
    settled: settled?.balance ?? 0,
    pending: pending?.balance ?? 0,
    withdrawn: Number(withdrawal?.total ?? 0),
  };
}

export const getCreatorCash = createCache({
  name: 'cash',
  fetch: fetchCreatorCash,
  ttlSeconds: 60,
}).get;
