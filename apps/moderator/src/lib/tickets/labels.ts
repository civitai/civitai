/** How a Badge should read a subscription status (Stripe's and Paddle's, as stored on `CustomerSubscription`). */
export type SubscriptionBadge = 'secondary' | 'destructive' | 'outline';

const SUBSCRIPTION_BADGES: Record<string, SubscriptionBadge> = {
  active: 'secondary',
  trialing: 'secondary',
  // The member is in a failed-payment state: worth the agent's eye.
  past_due: 'destructive',
  unpaid: 'destructive',
  incomplete: 'destructive',
  // Over: informational, not an alarm.
  canceled: 'outline',
  incomplete_expired: 'outline',
};

/** Unknown statuses read as neutral rather than as an alarm. */
export const subscriptionBadge = (status: string): SubscriptionBadge =>
  SUBSCRIPTION_BADGES[status] ?? 'outline';
