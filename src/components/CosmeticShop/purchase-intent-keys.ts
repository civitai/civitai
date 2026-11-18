import { withPaymentIntentKey } from '~/components/Buzz/payment-intent-keys';
import { PURCHASE_ALREADY_COMPLETED_MESSAGE } from '~/shared/constants/cosmetic-shop.constants';

/** The server's answer when this key's purchase was already granted. */
export function isPurchaseAlreadyCompleted(error: unknown): boolean {
  return (error as { message?: unknown } | null)?.message === PURCHASE_ALREADY_COMPLETED_MESSAGE;
}

/**
 * Sends a purchase under the shop item's intent key: one intent per item, held and released by
 * `withPaymentIntentKey`. "Already completed" is a 400, so it ends the intent like any other
 * decline; the caller reports it as a completed purchase.
 *
 * A caller that brings its own key keeps full control of it.
 */
export async function withPurchaseIntentKey<T>(
  shopItemId: number,
  givenKey: string | undefined,
  send: (idempotencyKey: string) => Promise<T>
): Promise<T> {
  if (givenKey) return send(givenKey);
  return withPaymentIntentKey(`cosmetic:${shopItemId}`, send);
}
