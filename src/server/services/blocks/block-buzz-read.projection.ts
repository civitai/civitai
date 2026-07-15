import { TransactionType } from '~/shared/constants/buzz.constants';
import type { getUserBuzzTransactions } from '~/server/services/buzz.service';

/**
 * Block-facing projection for the buzz self-read bridges (host-mediated
 * `blocks.getMyBuzzTransactions`). Extracted as a PURE, dependency-light module
 * so the security-critical field stripping is unit-testable in isolation —
 * independent of the block router's heavy import chain.
 *
 * Two leak-class defenses carried over from the security review of the original
 * REST endpoints (#3132/#3140):
 *
 *  (A) `details` allowlist — `buzzTransactionDetails` is a `.passthrough()`
 *      object and Purchase rows store `details.stripePaymentIntentId` (see
 *      buzz.service `completeStripeBuzzPurchase`). An unfiltered spread would
 *      ship the user's Stripe payment-intent reference into the third-party
 *      block iframe, so we pick ONLY the entity-attribution fields the dashboard
 *      renders and drop every passthrough key.
 *
 *  (B) `externalTransactionId` leak class — the field is DUAL-USE and
 *      TransactionType does NOT cleanly separate the two uses (an evidence-based
 *      sweep of every `externalTransactionId` assignment in the buzz + payment
 *      services). It holds a raw payment-processor / external-financial
 *      reference on the money-movement types, and a civitai-internal
 *      prize/reward classifier elsewhere:
 *        • Purchase   – every external buy-in lands here via grantBuzzPurchase /
 *                       completeStripeBuzzPurchase: Stripe paymentIntent.id +
 *                       invoice.id, Paddle transaction.id, `PAYPAL_ORDER:<id>`,
 *                       NOWPayments/Coinbase/EmerchantPay order ids, subscription
 *                       payment refs.
 *        • Refund     – a PayPal reversal stores the BARE PayPal transaction id
 *                       (paypal.service) with no distinguishing prefix, so the
 *                       whole type is nulled.
 *        • ChargeBack / Withdrawal – payment-dispute / cash-out financial-movement
 *                       types; nulled defensively (no dashboard classifier need;
 *                       future processor/bank refs land here by convention).
 *      Plus the ONE cross-type value: merch grants a Shopify order id under type
 *      *Reward* as `merchPurchase:<shopifyOrderId>` (merch.service), nulled by
 *      prefix. Every OTHER row keeps its classifier (challenge-entry/winner
 *      prizes, `referral-reward:*`, generic reward-event ids, bounty/comp tags).
 */

const EXTERNAL_TXN_ID_SENSITIVE_TYPES = new Set<TransactionType>([
  TransactionType.Purchase,
  TransactionType.Refund,
  TransactionType.ChargeBack,
  TransactionType.Withdrawal,
]);
const EXTERNAL_TXN_ID_SENSITIVE_VALUE_PREFIXES = ['merchPurchase:'];

/**
 * Null `externalTransactionId` wherever it holds a payment-processor /
 * external-financial reference (money-movement types + the merch Shopify value);
 * pass it through where it is a civitai-internal prize/reward classifier.
 */
export function projectExternalTransactionId(
  type: TransactionType,
  externalTransactionId: string | null | undefined
): string | null {
  if (EXTERNAL_TXN_ID_SENSITIVE_TYPES.has(type)) return null;
  if (
    externalTransactionId != null &&
    EXTERNAL_TXN_ID_SENSITIVE_VALUE_PREFIXES.some((p) => externalTransactionId.startsWith(p))
  )
    return null;
  return externalTransactionId ?? null;
}

type BlockBuzzTransactionRow = Awaited<
  ReturnType<typeof getUserBuzzTransactions>
>['transactions'][number];

/**
 * Project one hydrated buzz-transaction row to the block-safe shape:
 *  - `type` serialized as its enum NAME
 *  - `details` allowlisted to the entity-attribution fields (drop passthrough,
 *    incl. `stripePaymentIntentId`)
 *  - `externalTransactionId` stripped for processor-reference rows (see above)
 *  - counterparties projected to `{ id, username }` (no other `getUsers` fields)
 */
export function projectBlockBuzzTransaction(row: BlockBuzzTransactionRow) {
  const { toUser, fromUser, details, externalTransactionId, ...t } = row;
  return {
    ...t,
    type: TransactionType[t.type],
    details: details
      ? {
          user: details.user,
          entityId: details.entityId,
          entityType: details.entityType,
          url: details.url,
          toAccountType: details.toAccountType,
        }
      : details,
    externalTransactionId: projectExternalTransactionId(t.type, externalTransactionId),
    toUser: toUser ? { id: toUser.id, username: toUser.username } : undefined,
    fromUser: fromUser ? { id: fromUser.id, username: fromUser.username } : undefined,
  };
}
