import type { PrepaidToken } from '~/server/schema/subscriptions.schema';
import {
  BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE,
  badStateSubscriptionStatuses,
  isMembershipActive,
  isMetadataTrue,
  terminalSubscriptionStatuses,
} from '~/shared/utils/buzz-membership';

export type MembershipPaymentMethod = 'card' | 'prepaid' | 'buzz' | 'gift' | 'referral';

export const membershipPaymentMethodLabels: Record<MembershipPaymentMethod, string> = {
  card: 'Card',
  prepaid: 'Prepaid code',
  buzz: 'Buzz',
  gift: 'Gift',
  referral: 'Referral reward',
};

export function getMembershipPaymentMethod({
  slot,
  provider,
  productMetadata,
  metadata,
}: {
  slot: string;
  provider: string;
  productMetadata: unknown;
  metadata: unknown;
}): MembershipPaymentMethod {
  const productMeta = (productMetadata ?? {}) as Record<string, unknown>;
  const meta = (metadata ?? {}) as Record<string, unknown>;

  if (slot === BUZZ_MEMBERSHIP_SUBSCRIPTION_TYPE || isMetadataTrue(productMeta.buzzPurchase))
    return 'buzz';
  if (slot === 'referral' || meta.source === 'referral-redemption') return 'referral';
  if (isMetadataTrue(meta.membershipGift) || !!meta.membershipGiftId) return 'gift';
  // Civitai-provider rows outside the Buzz and referral slots come from redeemed codes
  // (bought with crypto, a gift card, or converted from a legacy prepaid plan).
  if (provider === 'Civitai') return 'prepaid';
  return 'card';
}

export type MembershipHistoryState =
  | { state: 'renews'; date: Date }
  | { state: 'ends'; date: Date }
  | { state: 'ended'; date: Date; reason: string }
  | { state: 'payment-failed' };

type MembershipHistoryStateInput = {
  status: string;
  paymentMethod: MembershipPaymentMethod;
  cancelAt: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  endedAt: Date | null;
  currentPeriodEnd: Date;
  /** Why CustomerSubscriptionHistory closed the row, when it did. */
  closedReason?: string | null;
};

function getEndReason({
  status,
  paymentMethod,
  endedAt,
  currentPeriodEnd,
  closedReason,
}: MembershipHistoryStateInput) {
  if (closedReason === 'replaced') return 'Replaced by a new subscription';
  if (closedReason === 'plan-changed') return 'Changed to a different plan';
  if (status === 'incomplete_expired') return 'The first payment never went through';
  switch (paymentMethod) {
    case 'buzz':
      // supersedeBuzzMembershipForPaidSubscription ends a Buzz membership early when a paid one starts.
      return endedAt && endedAt < currentPeriodEnd
        ? 'Replaced by a paid membership'
        : 'The month bought with Buzz ran out';
    case 'prepaid':
      return 'The prepaid period ran out';
    case 'gift':
      return 'The gifted months ran out';
    case 'referral':
      return 'The referral reward period ran out';
    case 'card':
      return 'Canceled';
  }
}

/** Plain-words status for one membership row, including rows that have already ended. */
export function getMembershipHistoryState(
  input: MembershipHistoryStateInput,
  now: Date = new Date()
): MembershipHistoryState {
  const { status, paymentMethod, cancelAt, cancelAtPeriodEnd, canceledAt, endedAt } = input;
  const currentPeriodEnd = new Date(input.currentPeriodEnd);

  if (terminalSubscriptionStatuses.includes(status) || endedAt || input.closedReason) {
    return {
      state: 'ended',
      date: new Date(endedAt ?? canceledAt ?? currentPeriodEnd),
      reason: getEndReason(input),
    };
  }

  // incomplete_expired is also a bad state, but it is terminal and returned as ended above.
  if (badStateSubscriptionStatuses.includes(status)) return { state: 'payment-failed' };

  // Only card memberships renew on their own; everything else runs out at period end.
  const endsAtPeriodEnd = !!cancelAt || cancelAtPeriodEnd || paymentMethod !== 'card';
  if (!endsAtPeriodEnd) return { state: 'renews', date: currentPeriodEnd };
  // The expiry job hasn't flipped the row yet; agree with the purchase guard on when it lapsed.
  if (!isMembershipActive({ currentPeriodEnd }, now))
    return { state: 'ended', date: currentPeriodEnd, reason: getEndReason(input) };
  return { state: 'ends', date: new Date(cancelAt ?? currentPeriodEnd) };
}

export type PrepaidTokenSummary = {
  total: number;
  claimed: number;
  readyToClaim: number;
  upcoming: number;
};

export function summarizePrepaidTokens(tokens: PrepaidToken[]): PrepaidTokenSummary | null {
  if (!tokens.length) return null;
  return {
    total: tokens.length,
    claimed: tokens.filter((token) => token.status === 'claimed').length,
    readyToClaim: tokens.filter((token) => token.status === 'unlocked').length,
    upcoming: tokens.filter((token) => token.status === 'locked').length,
  };
}
