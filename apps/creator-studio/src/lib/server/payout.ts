import { dbRead } from '$lib/server/db';

// Read-only Tipalti payout status from UserPaymentConfiguration. Mirrors how the main app reads eligibility
// (tipaltiPaymentsEnabled / tipaltiAccountStatus). We never onboard/withdraw here — that's a link-out to the
// Buzz dashboard.
export type PayoutStatus = 'active' | 'pending' | 'not_set_up';

export async function getPayoutStatus(userId: number): Promise<PayoutStatus> {
  const row = await dbRead
    .selectFrom('UserPaymentConfiguration')
    .select(['tipaltiAccountId', 'tipaltiAccountStatus', 'tipaltiPaymentsEnabled'])
    .where('userId', '=', userId)
    .executeTakeFirst();

  if (!row?.tipaltiAccountId) return 'not_set_up';
  if (row.tipaltiPaymentsEnabled || row.tipaltiAccountStatus === 'Active') return 'active';
  return 'pending';
}
