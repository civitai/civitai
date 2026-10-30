import type { getPayouts } from '../user-account.service';
import { SUPPORT_ROWS } from '$lib/tickets/support-panels';

/**
 * One withdrawal request, allow-listed field by field. Deliberately not carried: bank or account
 * details, provider account ids, contacts and the free-text note, so nothing the service row gains
 * later reaches the page.
 */
export type PayoutRow = {
  /** The request id, tagged with its table: a stable key for the row. */
  id: string;
  /** `buzz` amounts are Buzz, `cash` amounts are cents: the two are not addable. */
  kind: 'buzz' | 'cash';
  at: string | null;
  status: string;
  requested: number;
  /** What actually moved; null when nothing has been transferred against the request. */
  transferred: number | null;
  /** The provider's name only. */
  provider: string | null;
};

export type TicketPayouts =
  | { status: 'unlinked' }
  | { status: 'unavailable'; userId: number }
  | { status: 'ok'; userId: number; payouts: PayoutRow[]; truncated: boolean };

export type PayoutsReads = {
  payouts: (userId: number, limit: number) => ReturnType<typeof getPayouts>;
};

// Imported when read, so loading the ticket detail module opens no database connection.
const liveReads: PayoutsReads = {
  payouts: async (userId, limit) =>
    (await import('../user-account.service')).getPayouts(userId, limit),
};

/** The linked user's newest payout and withdrawal requests. The caller has checked the User Lookup grant. */
export async function payoutsSectionFor(
  ticket: { userId: number },
  reads: PayoutsReads = liveReads
): Promise<Extract<TicketPayouts, { status: 'ok' }>> {
  const { userId } = ticket;
  const { items, truncated } = await reads.payouts(userId, SUPPORT_ROWS);
  return {
    status: 'ok',
    userId,
    truncated,
    payouts: items.map(
      (p): PayoutRow => ({
        id: p.key,
        kind: p.kind,
        at: p.createdAt?.toISOString() ?? null,
        status: p.status,
        requested: p.requested,
        transferred: p.transferred,
        provider: p.provider,
      })
    ),
  };
}
