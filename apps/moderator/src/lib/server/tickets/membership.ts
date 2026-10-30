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
  /** `month` / `year`. */
  interval: string | null;
  /** Minor units of `currency`. */
  unitAmount: number | null;
  currency: string | null;
};

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

/** The linked user's current subscription. The caller has checked the User Lookup grant. A failing read is `unavailable`. */
export async function membershipSectionFor(
  ticket: { userId: number },
  reads: MembershipReads = liveReads
): Promise<Extract<TicketMembership, { status: 'ok' | 'unavailable' }>> {
  const { userId } = ticket;
  try {
    const s = await reads.subscription(userId);
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
        interval: s.interval,
        unitAmount: s.unitAmount,
        currency: s.currency,
      },
    };
  } catch (e) {
    console.error('[tickets] membership failed', e);
    return { status: 'unavailable', userId };
  }
}
