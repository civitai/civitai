import type { getSubscription } from '../user-lookup.service';

/**
 * The current subscription as a support agent needs it. Deliberately not carried: membership codes
 * (their own grant), the payment method and the provider's customer and subscription ids.
 */
export type TicketSubscription = {
  productName: string | null;
  provider: string | null;
  status: string;
  /** `buzzPurchase` / `referral` mark a perks-only row rather than a card-paid membership. */
  buzzType: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  /** `day` / `week` / `month` / `year`; null on a perks-only row, which no card pays. */
  interval: string | null;
  /** Minor units of `currency`; null on a perks-only row. */
  unitAmount: number | null;
  currency: string | null;
};

/** A `buzzPurchase` / `referral` row is a grant, not a card payment: any price it joins to is the product's list price. */
const PERKS_ONLY = new Set(['buzzPurchase', 'referral']);

export type TicketMembership =
  | { status: 'unlinked' }
  | { status: 'unavailable'; userId: number }
  | { status: 'ok'; userId: number; subscription: TicketSubscription | null };

export type MembershipReads = {
  subscription: (userId: number) => ReturnType<typeof getSubscription>;
};

// Imported when read, so loading the ticket detail module opens no database connection.
const liveReads: MembershipReads = {
  subscription: async (userId) => (await import('../user-lookup.service')).getSubscription(userId),
};

/** The linked user's current subscription. The caller has checked the User Lookup grant. */
export async function membershipSectionFor(
  ticket: { userId: number },
  reads: MembershipReads = liveReads
): Promise<Extract<TicketMembership, { status: 'ok' }>> {
  const { userId } = ticket;
  const s = await reads.subscription(userId);
  const paidByCard = !!s && !PERKS_ONLY.has(s.buzzType ?? '');
  return {
    status: 'ok',
    userId,
    subscription: s && {
      productName: s.productName,
      provider: s.provider,
      status: s.status,
      buzzType: s.buzzType,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd === true,
      currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null,
      interval: paidByCard ? s.interval : null,
      unitAmount: paidByCard ? s.unitAmount : null,
      currency: paidByCard ? s.currency : null,
    },
  };
}
