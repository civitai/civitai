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
 *      every passthrough key. Beyond the entity-attribution fields, the
 *      classifier keys are allowlisted (evidence-based sweep of every
 *      `details:` writer):
 *        • `type` + `forId` — the reward-event tag + subject id every
 *          Reward/Incentive row carries (rewards/base.reward.ts `sendAward`;
 *          the effective value is `getKey`'s returned `type`, which overrides
 *          the definition's top-level `type` via the `...definedKey` spread).
 *          These are NOT passed through for every reward type: `type` is an
 *          internal classifier and several reward tags identify OTHER users or
 *          the viewer's moderation/social activity, which must NOT reach an
 *          untrusted installed block. So `type` (and, with it, `forId`) is kept
 *          ONLY when `type` names a dashboard-relevant income / attribution
 *          event — a CURATED allowlist, `isDashboardClassifierType` below:
 *            - exact: `dailyBoost`, `imagePostedToModel`, `firstDailyPost`,
 *              and the early-access purchase kinds `download` / `generation`
 *              (model-version.service).
 *            - prefix: `goodContent:<kind>`, `collectedContent:<kind>` (the
 *              per-entity reaction/collection income tags; matched by prefix
 *              because the writers append `:<entityType>`).
 *          Everything else DROPS both `type` and `forId`. This structurally
 *          excludes the leak-class tags an open pass-through would have shipped:
 *          `reportAccepted` (the viewer's moderation-report activity + reportId
 *          — the sharpest leak), `refereeCreated` (the referrer's user id — the
 *          referral edge), `firstDailyFollow` (the followed user's id — a follow
 *          edge), `encouragement:<kind>` (the viewer's reaction footprint), plus
 *          `ad-watched` / `appBlockReview` / `generation-feedback` /
 *          `userReferred` — AND, by DEFAULT, any FUTURE reward type until it is
 *          deliberately added to the allowlist (default-deny, not a denylist).
 *          `forId` additionally keeps a NUMERIC-ONLY guard (every allowlisted
 *          tag's subject id is a number; the one string-valued writer is
 *          adWatched's session token, already excluded by type).
 *        • `modelVersionId` — the early-access sale's sold version
 *          (model-version.service `details: { modelVersionId, type,
 *          earlyAccessPurchase: true }`) — per-version sales attribution.
 *          Only written by the allowlisted `download`/`generation` kinds and
 *          always a public version id. Number-guarded.
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

/**
 * Curated allowlist of `details.type` classifiers safe to expose to an untrusted
 * installed block — the dashboard-relevant income / attribution events only.
 * Exact matches + the `:<kind>`-suffixed reaction/collection income tags
 * (prefix). Anything not listed — including every FUTURE reward type — is
 * default-denied (drops both `type` and `forId`). This is deliberately a
 * structural ALLOWLIST, never a denylist: adding a new dashboard type is an
 * explicit, tested decision, and a new sensitive tag can never leak by omission.
 */
const DASHBOARD_CLASSIFIER_TYPES = new Set<string>([
  'dailyBoost',
  'imagePostedToModel',
  'firstDailyPost',
  // Early-access purchase kinds (model-version.service `details.type`).
  'download',
  'generation',
]);
const DASHBOARD_CLASSIFIER_TYPE_PREFIXES = ['goodContent:', 'collectedContent:'];

export function isDashboardClassifierType(type: unknown): type is string {
  if (typeof type !== 'string') return false;
  if (DASHBOARD_CLASSIFIER_TYPES.has(type)) return true;
  return DASHBOARD_CLASSIFIER_TYPE_PREFIXES.some((p) => type.startsWith(p));
}

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
          // Classifier keys (see leak-class (A) above): `type` + `forId` are
          // kept ONLY for the curated dashboard income/attribution types — a
          // structural default-deny that excludes moderation/referral/follow/
          // reaction tags AND any future reward type. `forId` keeps a numeric
          // guard on top (belt-and-suspenders against a string subject id).
          type: isDashboardClassifierType(d.type) ? d.type : undefined,
          forId:
            isDashboardClassifierType(d.type) &&
            typeof d.forId === 'number' &&
            Number.isFinite(d.forId)
              ? d.forId
              : undefined,
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
