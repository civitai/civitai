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
 *      block iframe, so we pick ONLY the fields the dashboard needs and drop
 *      every passthrough key. Beyond the entity-attribution fields, three
 *      CLASSIFIER keys are allowlisted (evidence-based sweep of every
 *      `details:` writer):
 *        • `type` — the reward-event tag every Reward/Incentive row carries
 *          (rewards/base.reward.ts `sendAward`: 'dailyBoost', 'goodContent:<kind>',
 *          'collectedContent:<kind>', 'imagePostedToModel', 'adWatched', …) and
 *          the early-access purchase kind ('download' | 'generation',
 *          model-version.service). Internal tags only — this is what a rewards
 *          audit / income-stream breakdown classifies on. String-guarded.
 *        • `forId` — the reward's subject id (dailyBoost: the claimed day as
 *          YYYYMMDD, imagePostedToModel: modelVersionId, firstDailyPost: postId,
 *          goodContent: entityId, …). NUMERIC-ONLY: the one string-valued case
 *          is adWatched's `input.token` (the watched-ad session token,
 *          adWatched.reward.ts) — an opaque external token with no dashboard
 *          use, excluded by the number guard. Every dashboard classifier
 *          (claim-calendar day, entity ids) is a number.
 *        • `modelVersionId` — the early-access sale's sold version
 *          (model-version.service `details: { modelVersionId, type,
 *          earlyAccessPurchase: true }`) — per-version sales attribution.
 *          Number-guarded.
 *      Still dropped (present on reward rows): `byUserId` — who triggered the
 *      reward (reactor/collector identity); reactions are anonymous on the
 *      site, so the block must not see it either.
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
 *  - `details` allowlisted to the entity-attribution + classifier fields (drop
 *    passthrough, incl. `stripePaymentIntentId` and `byUserId`; `forId` only
 *    when numeric — the adWatched token guard)
 *  - `externalTransactionId` stripped for processor-reference rows (see above)
 *  - counterparties projected to `{ id, username }` (no other `getUsers` fields)
 */
export function projectBlockBuzzTransaction(row: BlockBuzzTransactionRow) {
  const { toUser, fromUser, details, externalTransactionId, ...t } = row;
  // details is a zod .passthrough() object — classifier keys are untyped.
  const d = details as (typeof details & Record<string, unknown>) | null | undefined;
  return {
    ...t,
    type: TransactionType[t.type],
    details: d
      ? {
          user: d.user,
          entityId: d.entityId,
          entityType: d.entityType,
          url: d.url,
          toAccountType: d.toAccountType,
          // Classifier keys (see leak-class (A) above): internal tags/ids only.
          type: typeof d.type === 'string' ? d.type : undefined,
          forId: typeof d.forId === 'number' && Number.isFinite(d.forId) ? d.forId : undefined,
          modelVersionId:
            typeof d.modelVersionId === 'number' && Number.isFinite(d.modelVersionId)
              ? d.modelVersionId
              : undefined,
        }
      : d,
    externalTransactionId: projectExternalTransactionId(t.type, externalTransactionId),
    toUser: toUser ? { id: toUser.id, username: toUser.username } : undefined,
    fromUser: fromUser ? { id: fromUser.id, username: fromUser.username } : undefined,
  };
}
