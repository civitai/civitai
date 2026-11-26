/**
 * What a short buyer's Buzz purchase runs once it succeeds: the pending action, or nothing. A hold
 * must not be placed on the back of a purchase, so callers pass `performTransactionOnPurchase: false`.
 */
export function onPurchaseSuccessAction(
  performTransactionOnPurchase: boolean | undefined,
  onPerformTransaction: () => void
) {
  return performTransactionOnPurchase ? onPerformTransaction : undefined;
}
