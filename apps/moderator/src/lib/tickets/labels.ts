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

/** `FailedFee` -> "Failed fee", `past_due` -> "Past due": the fallback for a value no map names. */
export const humanize = (value: string): string => {
  const words = value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const labeller = (labels: Record<string, string>) => (value: string) =>
  labels[value] ?? humanize(value);

/** `CashWithdrawalStatus` and `BuzzWithdrawalRequestStatus` share the payouts list. */
export const payoutStatusLabel = labeller({
  // Cash (Tipalti)
  Paid: 'Paid',
  Rejected: 'Rejected',
  Scheduled: 'Scheduled',
  Submitted: 'Submitted',
  Deferred: 'Deferred',
  DeferredInternal: 'Deferred (internal)',
  Canceled: 'Canceled',
  Cleared: 'Cleared',
  FraudReview: 'Fraud review',
  PendingPayerFunds: 'Pending payer funds',
  InternalValue: 'Internal value',
  FailedFee: 'Failed fee',
  Reclaimed: 'Reclaimed',
  // Buzz
  Requested: 'Requested',
  Approved: 'Approved',
  Reverted: 'Reverted',
  Transferred: 'Transferred',
  ExternallyResolved: 'Resolved externally',
});

/** `ReportStatus`. */
export const reportStatusLabel = labeller({
  Pending: 'Pending',
  Processing: 'Processing',
  Actioned: 'Actioned',
  Unactioned: 'Dismissed',
});

/** `TrainingStatus`. */
export const trainingStatusLabel = labeller({
  Pending: 'Not submitted',
  Submitted: 'Submitted',
  Paused: 'Paused',
  Denied: 'Denied',
  Processing: 'Processing',
  InReview: 'In review',
  Failed: 'Failed',
  Approved: 'Published',
  Expired: 'Expired',
});

/** `UserRestrictionStatus`. */
export const restrictionStatusLabel = labeller({
  Pending: 'Pending',
  Upheld: 'Upheld',
  Overturned: 'Overturned',
  AccountDeleted: 'Account deleted',
});

/** `BountyType`. */
export const bountyTypeLabel = labeller({
  ModelCreation: 'Model',
  LoraCreation: 'LoRA',
  EmbedCreation: 'Embedding',
  DataSetCreation: 'Dataset',
  DataSetCaption: 'Dataset captioning',
  ImageCreation: 'Image',
  VideoCreation: 'Video',
  Other: 'Other',
});

const INTERVAL_LABELS: Record<string, string> = {
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
  year: 'yearly',
};

/** A price's billing interval as an adjective; an unknown one reads as it is stored. */
export const intervalLabel = (interval: string): string => INTERVAL_LABELS[interval] ?? interval;

/**
 * A price held in minor units, in its currency's own: 999 cents is $9.99, 999 yen is ¥999. A currency
 * code `Intl` does not know falls back to the code beside two decimals.
 */
export function formatMinorUnits(amount: number, currency: string | null): string {
  const code = (currency ?? '').toUpperCase();
  try {
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
    const digits = money.resolvedOptions().maximumFractionDigits ?? 2;
    return money.format(amount / 10 ** digits);
  } catch {
    return `${(amount / 100).toFixed(2)} ${code}`.trim();
  }
}

/** A PascalCase reason or activity name as words: `CopyrightInfringement` reads "Copyright Infringement". */
export const spaced = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2');
