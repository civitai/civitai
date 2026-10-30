import type { getShopPurchases } from '../user-account.service';
import { SUPPORT_ROWS } from '$lib/tickets/support-panels';

export type ShopPurchaseRow = {
  /** The purchase's Buzz transaction id: a stable key for the row. */
  id: string;
  title: string;
  /** Buzz paid. */
  amount: number;
  at: string;
  refunded: boolean;
};

export type TicketShop =
  | { status: 'unlinked' }
  | { status: 'unavailable'; userId: number }
  | { status: 'ok'; userId: number; purchases: ShopPurchaseRow[]; truncated: boolean };

export type ShopReads = {
  purchases: (userId: number, limit: number) => ReturnType<typeof getShopPurchases>;
};

// Imported when read, so loading the ticket detail module opens no database connection.
const liveReads: ShopReads = {
  purchases: async (userId, limit) =>
    (await import('../user-account.service')).getShopPurchases(userId, limit),
};

/** The linked user's newest Cosmetic Shop purchases. The caller has checked the User Lookup grant. */
export async function shopSectionFor(
  ticket: { userId: number },
  reads: ShopReads = liveReads
): Promise<Extract<TicketShop, { status: 'ok' }>> {
  const { userId } = ticket;
  const { items, truncated } = await reads.purchases(userId, SUPPORT_ROWS);
  return {
    status: 'ok',
    userId,
    truncated,
    purchases: items.map(
      (p): ShopPurchaseRow => ({
        id: p.buzzTransactionId,
        title: p.title,
        amount: p.unitAmount,
        at: p.purchasedAt.toISOString(),
        refunded: p.refunded,
      })
    ),
  };
}
