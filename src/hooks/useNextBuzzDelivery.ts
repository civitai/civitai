import dayjs, { type Dayjs } from 'dayjs';
import { useActiveSubscription } from '~/components/Stripe/memberships.util';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { SubscriptionMetadata } from '~/server/schema/subscriptions.schema';

/**
 * Calculate the next buzz delivery date based on subscription currentPeriodStart
 * Matches the logic from deliver-civitai-membership-buzz job
 */
function calculateNextBuzzDeliveryDate(currentPeriodStart: Dayjs, now: Dayjs): Dayjs | null {
  const deliveryDay = currentPeriodStart.date(); // Day of month from currentPeriodStart

  // Start with current month
  let nextDelivery = now.date(deliveryDay);

  // If the delivery day doesn't exist in current month (e.g., 31st in Feb)
  // use the last day of the month (matches job's month-end handling)
  const daysInCurrentMonth = now.daysInMonth();
  if (deliveryDay > daysInCurrentMonth) {
    nextDelivery = now.date(daysInCurrentMonth);
  }

  // If we've already passed this month's delivery, move to next month
  if (nextDelivery.isBefore(now, 'day') || nextDelivery.isSame(now, 'day')) {
    nextDelivery = nextDelivery.add(1, 'month');

    // Handle month-end edge case for next month
    const daysInNextMonth = nextDelivery.daysInMonth();
    if (deliveryDay > daysInNextMonth) {
      nextDelivery = nextDelivery.date(daysInNextMonth);
    } else {
      nextDelivery = nextDelivery.date(deliveryDay);
    }
  }

  return nextDelivery;
}

interface UseNextBuzzDeliveryParams {
  buzzType?: BuzzSpendType; // Optional: specific buzz type to check
  totalEndDate?: Dayjs; // Optional: for prepaid timelines
}

interface UseNextBuzzDeliveryResult {
  nextBuzzDelivery: Dayjs | null;
  buzzAmount: number | null;
  hasPrepaidsForCurrentTier: boolean;
  shouldShow: boolean;
}

/**
 * Hook to calculate and validate the next buzz delivery for the current user's subscription
 * Only shows delivery info if:
 * 1. Product has monthly buzz configured
 * 2. User has prepaid deliveries remaining for the current tier
 * 3. Next delivery falls within the prepaid timeline (if provided)
 */
export function useNextBuzzDelivery({
  buzzType,
  totalEndDate,
}: UseNextBuzzDeliveryParams = {}): UseNextBuzzDeliveryResult {
  const { subscription } = useActiveSubscription({ buzzType });

  if (!subscription) {
    return {
      nextBuzzDelivery: null,
      buzzAmount: null,
      hasPrepaidsForCurrentTier: false,
      shouldShow: false,
    };
  }

  const metadata = subscription.metadata as SubscriptionMetadata | null;
  const prepaids = metadata?.prepaids;
  const currentTier = subscription.product?.metadata?.tier;
  const monthlyBuzz = subscription.product?.metadata?.monthlyBuzz;
  const currentPeriodStart = dayjs(subscription.currentPeriodStart);
  const now = dayjs();

  // Check if product has monthly buzz configured
  const hasMonthlyBuzz = monthlyBuzz && Number(monthlyBuzz) > 0;

  // Check if user has prepaid deliveries for the current tier
  const hasPrepaidsForCurrentTier = !!(
    prepaids &&
    currentTier &&
    prepaids[currentTier] &&
    prepaids[currentTier]! > 0
  );

  // Calculate next delivery date
  const nextBuzzDelivery = hasMonthlyBuzz
    ? calculateNextBuzzDeliveryDate(currentPeriodStart, now)
    : null;

  // Check if delivery falls within prepaid timeline (if timeline is provided)
  const deliveryWithinTimeline = totalEndDate
    ? nextBuzzDelivery && nextBuzzDelivery.isBefore(totalEndDate)
    : true; // If no timeline provided, assume it's within range

  // Should show if all conditions are met
  const shouldShow = !!(hasMonthlyBuzz && hasPrepaidsForCurrentTier && deliveryWithinTimeline);

  return {
    nextBuzzDelivery,
    buzzAmount: hasMonthlyBuzz ? Number(monthlyBuzz) : null,
    hasPrepaidsForCurrentTier,
    shouldShow,
  };
}
