import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  createBuzzTransaction,
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
  refundTransaction,
} from '~/server/services/buzz.service';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';
import { withRetries } from '~/server/utils/errorHandling';
import { TransactionType } from '~/shared/constants/buzz.constants';
import type { BuzzAccountType } from '~/shared/constants/buzz.constants';
import {
  BLOCK_GOOD_MAX_PRICE_BUZZ,
  blueLegOfPayout,
  computeBlockGoodSplit,
  findManifestGood,
} from '~/shared/constants/block-goods.constants';
import type { BlockGoodDeclaration } from '~/shared/constants/block-goods.constants';
import { newBlockGoodEntitlementId, newBlockGoodPurchaseId } from '~/server/utils/app-block-ids';

/**
 * App Blocks DIGITAL GOODS — the purchase and entitlement rail.
 *
 * The platform sells a manifest-declared entitlement to a viewer for Buzz, on
 * an app's behalf, and owns the ledger. The good's MEANING is the app's
 * business: the entitlement carries an opaque, manifest-sourced payload the
 * platform never interprets.
 *
 * 🔴 EVERY MONEY INPUT IS SERVER-DERIVED (FIN-1). The buyer is the verified
 * block-token subject; the app, its owner, the good and its price come from the
 * APPROVED AppBlock row that `claims.appBlockId` names. Nothing here reads a
 * client-supplied user id, app id, owner or price. The only client input that
 * reaches a decision is the `goodId` — a lookup key into a review-gated catalog
 * — and an optional `expectedPriceBuzz`, which can only cause a REFUSAL.
 *
 * 🔴 THE PAYOUT IS IMMEDIATE, in the same request, mirroring
 * `purchaseCosmeticShopItem`: buyer → bank (`Purchase`), bank → app owner
 * (`Sell`), split proportionally across the colours the buyer actually paid in.
 * There is no settlement job. What was actually paid is RECORDED on the
 * purchase row so a refund reverses those exact transactions instead of
 * re-deriving a split that may no longer produce the same numbers.
 */

export const BLOCK_GOODS_LOG_NAME = 'block-goods';

// 🔴 DEFENCE IN DEPTH, NOT THE DECISION. `withBlockScope` already resolved the
// approved-status verdict for this request (`resolveRestApprovalVerdict` in
// `src/server/middleware/block-scope.middleware.ts`), and that predicate — not
// this literal — is the one place the REST surface decides it. This check exists
// for a future non-HTTP caller (a mod tool, a job) that does not pass through the
// middleware; it must never be the reason a purchase is allowed.
const APP_BLOCK_APPROVED_STATUS = 'approved';
/** Claimed, charge outcome not yet settled. See `purchaseBlockGood`. */
const PURCHASE_STATUS_PENDING = 'pending';
const PURCHASE_STATUS_PAID = 'paid';
const PURCHASE_STATUS_REFUNDED = 'refunded';

/** What was actually paid to one recipient, in one colour. */
export type BlockGoodPayout = {
  userId: number;
  amount: number;
  color: BuzzAccountType;
  transactionId?: string;
};

export type ResolvedBlockGood = {
  appId: string;
  appOwnerUserId: number;
  manifestVersion: string;
  good: BlockGoodDeclaration;
};

export type PurchaseBlockGoodInput = {
  /** The verified token subject. Never a body field. */
  buyerUserId: number;
  /** From `claims.appBlockId`. Never a body field. */
  appBlockId: string;
  /** From `claims.blockInstanceId`; attribution only, and allowed to be unresolvable. */
  blockInstanceId?: string | null;
  goodId: string;
  /**
   * The server-derived catalog entry, from `resolveBlockGoodForPurchase`.
   *
   * 🔴 PASSED IN RATHER THAN RE-READ, so the price the caller reserved the
   * viewer's daily cap against and the price actually charged are the SAME
   * read. Resolving twice opens a window in which an approved re-price lands
   * between them and the reservation no longer matches the charge.
   */
  resolved: ResolvedBlockGood;
  /** Optional confirm-the-price guard: a mismatch refuses rather than charges. */
  expectedPriceBuzz?: number;
  /** Buzz colours the buyer may pay from, in preference order. */
  payWith: BuzzAccountType[];
};

export type PurchaseBlockGoodResult =
  | {
      ok: true;
      status: 200;
      purchaseId: string;
      goodId: string;
      priceBuzz: number;
      entitlement: SerializedEntitlement;
    }
  | { ok: false; status: number; error: string; reason: PurchaseRefusalReason };

/**
 * Why a purchase was refused.
 *
 * 🔴 CALLED `reason`, NOT `code`, DELIBERATELY. `code` is the key the repo's REST
 * error envelope owns (`src/server/utils/rest-error-envelope.ts`), and the values
 * it carries there are tRPC error-code strings so that the REST and tRPC surfaces
 * agree instead of inventing a second vocabulary. Putting a different vocabulary
 * on that same key is how a client that branches on `code` across two block
 * routes starts getting two meanings.
 */
export type PurchaseRefusalReason =
  | 'good_not_found'
  | 'price_changed'
  | 'price_over_cap'
  | 'already_owned'
  | 'self_purchase'
  | 'insufficient_funds'
  | 'duplicate'
  | 'pending_reconciliation'
  | 'charge_unknown'
  | 'charge_failed';

export type SerializedEntitlement = {
  goodId: string;
  kind: string;
  payload: unknown;
  grantedAt: string;
};

/**
 * The SERVER-TRUSTED resolution of a purchase: which app, which owner, which
 * good, at what price. Everything a charge needs, derived from `appBlockId`
 * alone.
 *
 * Returns null when the app is missing, not approved, or its manifest does not
 * currently declare a valid good under that id — which is also how a good
 * removed or broken by a later approved version stops being sellable, with no
 * separate delisting step.
 *
 * 🔴 IT READS THE LIVE MANIFEST AND IGNORES `BlockUserSubscription.pinnedVersion`
 * — a KNOWN divergence, recorded here rather than left to be discovered. A pinned
 * install's iframe renders v1's catalog while this charges v2's price, and a good
 * added in v2 is buyable by a viewer who was never shown it. `expectedPriceBuzz`
 * blunts the first half only, and it is optional. Resolving through the pinned
 * manifest is what `BlockRegistryService.applyPinnedVersion` exists for (it was
 * added because a v2 approve silently took effect on pinned installs — the C2
 * escalation); wiring it here needs the subscription, which needs instance
 * resolution, and that is the PR that adds the host wiring.
 *
 * ⚠️ It also costs TWO round trips, not one: `app: { select: { userId } }` is a
 * nested to-one relation and this schema has no `relationJoins`, so Prisma
 * resolves it separately. `block-approval.service.ts` documents the same and the
 * separate-query alternative costs the same, so this is noted rather than fixed.
 */
export async function resolveBlockGoodForPurchase(args: {
  appBlockId: string;
  goodId: string;
}): Promise<ResolvedBlockGood | null> {
  const appBlock = await dbRead.appBlock.findUnique({
    where: { id: args.appBlockId },
    select: {
      appId: true,
      status: true,
      version: true,
      manifest: true,
      app: { select: { userId: true } },
    },
  });
  if (!appBlock || appBlock.status !== APP_BLOCK_APPROVED_STATUS) return null;
  if (!appBlock.app?.userId) return null;

  const manifest = appBlock.manifest;
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return null;

  const good = findManifestGood(manifest as { goods?: unknown }, args.goodId);
  if (!good) return null;

  return {
    appId: appBlock.appId,
    appOwnerUserId: appBlock.app.userId,
    manifestVersion: appBlock.version,
    good,
  };
}

/**
 * The deterministic ledger key a purchase is charged under.
 *
 * 🔴 IT CARRIES NO RANDOMNESS AND NO CLIENT KEY, deliberately. A good is
 * single-ownership, so "this viewer buying this good from this app" names the
 * charge uniquely within one ownership generation. That makes the Buzz ledger's
 * own `externalTransactionId` uniqueness the authoritative dedupe: a retry
 * after every cache has expired still cannot move money twice. The client
 * `idempotencyKey` is a separate, faster layer (concurrency + verbatim replay)
 * and is deliberately NOT part of this string — folding it in would make two
 * different keys for one logical purchase and undo the guarantee.
 *
 * 🔴 `supersedesPurchaseId` IS WHAT MAKES A REFUNDED GOOD RE-BUYABLE, and
 * leaving it out is a real defect rather than a nicety. Without it the key is a
 * function of (app, good, buyer) alone, so the SECOND purchase of a refunded
 * good collides with the first on both the Buzz ledger and the UNIQUE
 * `buzz_transaction_id` — the viewer is told "this purchase has already been
 * completed" and can never buy it again. Keying the re-purchase to the row it
 * supersedes keeps every attempt within one generation idempotent (two
 * concurrent re-buys read the same revoked entitlement, so they derive the same
 * key and the ledger dedupes them) while giving each generation its own key.
 */
export function blockGoodPurchaseKey(args: {
  appBlockId: string;
  goodId: string;
  buyerUserId: number;
  /** The id of the purchase whose entitlement was revoked, when re-buying. */
  supersedesPurchaseId?: string | null;
}): string {
  const base = `block-good:${args.appBlockId}:${args.goodId}:${args.buyerUserId}`;
  return args.supersedesPurchaseId ? `${base}:after:${args.supersedesPurchaseId}` : base;
}

function serializeEntitlement(row: {
  goodId: string;
  kind: string;
  payload: unknown;
  grantedAt: Date;
}): SerializedEntitlement {
  return {
    goodId: row.goodId,
    kind: row.kind,
    payload: row.payload ?? {},
    grantedAt: row.grantedAt.toISOString(),
  };
}

/**
 * Buy one good. Returns a terminal result rather than throwing, so the endpoint
 * can cache it under an idempotency key; only a genuinely unexpected throw
 * escapes.
 *
 * 🔴 CLAIM-THEN-CHARGE, AND THE ORDER IS THE WHOLE SAFETY ARGUMENT. The purchase
 * row is INSERTED as `pending` — carrying the deterministic
 * `buzz_transaction_id` under its UNIQUE index — BEFORE any money moves. That
 * makes the database, not a read-then-check, the thing that serialises
 * attempts: exactly one attempt can ever reach the charge for a given key.
 *
 * Charge-then-claim was the obvious order and it is unsound here, for the
 * reason `purchaseCosmeticShopItem` records about its own key: with a
 * DETERMINISTIC prefix, two concurrent attempts both charge under it, one wins
 * the insert, and the loser's rollback — `refundMultiAccountTransaction` by
 * PREFIX — reverses *the winner's* charge while the winner keeps the
 * entitlement. The cosmetic shop escaped that by making its prefix random; this
 * rail cannot, because the deterministic prefix is what gives it ledger-backed
 * idempotency. Claiming first buys the same property from the other side: the
 * attempt that holds the row is the ONLY writer under that prefix, so a
 * prefix-wide rollback is unambiguous.
 *
 * The steps:
 *   1. refuse what must never charge (price cap, price change, self-purchase,
 *      already owned) — no money, no writes
 *   2. INSERT the `pending` row. A UNIQUE violation means another attempt owns
 *      this purchase: refuse, with nothing to roll back
 *   3. charge the buyer
 *   4. flip the row to `paid` and grant the entitlement, in one transaction
 *   5. pay the owner and record what was paid
 *
 * 🔴 A `pending` ROW IS THE RECONCILIATION SURFACE, not litter. It is deleted
 * only when the charge is KNOWN not to have moved money. When the outcome is
 * UNKNOWN — a 5xx, a timeout, a dropped connection — the row survives on
 * purpose: something may have been debited, and deleting the only record of it
 * would make the loss invisible. Those rows need a human or a job; the endpoint
 * surfaces them as `pending_reconciliation` rather than telling the viewer to
 * try again into a wall.
 */
export async function purchaseBlockGood(
  input: PurchaseBlockGoodInput
): Promise<PurchaseBlockGoodResult> {
  const { buyerUserId, appBlockId, goodId, expectedPriceBuzz, payWith, resolved } = input;
  const { appId, appOwnerUserId, manifestVersion, good } = resolved;
  const priceBuzz = good.priceBuzz;

  // Re-checked here and not only at manifest validation: a manifest approved
  // before the ceiling moved would otherwise keep charging the old price.
  if (priceBuzz > BLOCK_GOOD_MAX_PRICE_BUZZ) {
    return {
      ok: false,
      status: 400,
      reason: 'price_over_cap',
      error: 'This item is not available',
    };
  }

  // The buyer confirmed a number on a button. A catalog repriced between that
  // render and the press must refuse rather than charge a number they never
  // agreed to — the same guard the cosmetic shop makes.
  if (expectedPriceBuzz !== undefined && expectedPriceBuzz !== priceBuzz) {
    return {
      ok: false,
      status: 409,
      reason: 'price_changed',
      error: `The price changed to ${priceBuzz} Buzz. Check the new price and try again.`,
    };
  }

  // An owner buying their own good would pay themselves 70% through the bank and
  // burn 30% — a self-discount with a platform fee, not a sale. Refused, like a
  // creator buying their own cosmetic.
  if (appOwnerUserId === buyerUserId) {
    return {
      ok: false,
      status: 400,
      reason: 'self_purchase',
      error: 'You cannot buy your own app’s items',
    };
  }

  const existingEntitlement = await dbRead.blockGoodEntitlement.findUnique({
    where: { userId_appBlockId_goodId: { userId: buyerUserId, appBlockId, goodId } },
    select: {
      goodId: true,
      kind: true,
      payload: true,
      grantedAt: true,
      revokedAt: true,
      purchaseId: true,
    },
  });
  if (existingEntitlement && !existingEntitlement.revokedAt) {
    return {
      ok: false,
      status: 409,
      reason: 'already_owned',
      error: 'You already own this item',
    };
  }

  // A revoked entitlement means this viewer owned the good before, so the
  // purchase they are making now must be charged under its OWN key — see
  // `blockGoodPurchaseKey`.
  const transactionId = blockGoodPurchaseKey({
    appBlockId,
    goodId,
    buyerUserId,
    supersedesPurchaseId: existingEntitlement?.revokedAt ? existingEntitlement.purchaseId : null,
  });

  // The split depends only on the price, so it is known before the charge and is
  // written with the claim — which keeps the conservation CHECK satisfied from
  // the row's first moment. `bluePaidBuzz` is the one figure that needs the
  // charge's answer, so it starts at 0 and is set in step 4.
  const { appOwnerShare, platformShare } = computeBlockGoodSplit(priceBuzz);

  // ── STEP 2. CLAIM. The UNIQUE `buzz_transaction_id` is the lock. ────────────
  const purchaseId = newBlockGoodPurchaseId();
  try {
    await dbWrite.blockGoodPurchase.create({
      data: {
        id: purchaseId,
        userId: buyerUserId,
        appId,
        appBlockId,
        blockInstanceId: input.blockInstanceId ?? null,
        goodId,
        manifestVersion,
        priceBuzz,
        bluePaidBuzz: 0,
        appOwnerUserId,
        appOwnerShareBuzz: appOwnerShare,
        platformShareBuzz: platformShare,
        buzzTransactionId: transactionId,
        // Written EXPLICITLY rather than left to the column default. Prisma
        // carries a `Json` field's default as a STRING in the DMMF, and the
        // `jsonb_typeof(payouts) = 'array'` CHECK rejects a JSON string — so
        // relying on the default would make every insert depend on how the
        // client chooses to apply it.
        payouts: [],
        status: PURCHASE_STATUS_PENDING,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      void logToAxiom(
        {
          name: BLOCK_GOODS_LOG_NAME,
          type: 'error',
          message: 'purchase claim write failed',
          appBlockId,
          goodId,
          buyerUserId,
          error: messageOf(error),
        },
        'civitai-prod'
      ).catch(() => undefined);
      return {
        ok: false,
        status: 500,
        reason: 'charge_failed',
        error: 'Could not complete this purchase',
      };
    }

    // Another attempt owns this purchase. NOTHING is rolled back here — we never
    // charged, and the money under this key (if any) belongs to that attempt.
    // Which refusal the viewer sees depends on what state that attempt left:
    // a settled purchase is a duplicate; an unsettled one needs reconciliation,
    // and telling the viewer to retry would send them into a permanent wall.
    const owner = await dbWrite.blockGoodPurchase.findUnique({
      where: { buzzTransactionId: transactionId },
      select: { status: true },
    });
    if (owner?.status === PURCHASE_STATUS_PENDING) {
      return {
        ok: false,
        status: 409,
        reason: 'pending_reconciliation',
        error: 'A purchase of this item is still being settled. Support can help.',
      };
    }
    return {
      ok: false,
      status: 409,
      reason: 'duplicate',
      error: 'This purchase has already been completed',
    };
  }

  // ── STEP 3. CHARGE. We hold the key exclusively from here. ──────────────────
  let transaction: Awaited<ReturnType<typeof createMultiAccountBuzzTransaction>>;
  try {
    transaction = await createMultiAccountBuzzTransaction({
      fromAccountId: buyerUserId,
      fromAccountTypes: payWith,
      toAccountId: 0, // the bank
      amount: priceBuzz,
      type: TransactionType.Purchase,
      description: `App item purchase - ${good.title}`.slice(0, 100),
      externalTransactionIdPrefix: transactionId,
    });
  } catch (error) {
    // 🔴 A THROW HERE IS NOT AUTOMATICALLY "INSUFFICIENT FUNDS", and treating it
    // as one is a money bug. The Buzz client throws on ANY non-2xx and on a
    // network failure, and `mapError` collapses 401, 403, 408, 429 and every 5xx
    // into one INTERNAL_SERVER_ERROR — so the status is the only thing that
    // separates "the service refused, nothing moved" from "the gateway gave up
    // and the write may have landed". `getBuzzApiStatus` is the discriminator the
    // sibling App Blocks money path already uses for exactly this.
    const buzzStatus = getBuzzApiStatus(error);
    const knownPreMoney = buzzStatus === 400 || buzzStatus === 409 || buzzStatus === 404;

    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: knownPreMoney ? 'warning' : 'error',
        message: knownPreMoney ? 'purchase charge refused' : 'purchase charge outcome UNKNOWN',
        appBlockId,
        goodId,
        buyerUserId,
        purchaseId,
        transactionId,
        buzzStatus: buzzStatus ?? null,
        // Logged, never returned: a driver-authored string on the wire is the
        // civitai#3845 disclosure class.
        detail: messageOf(error),
      },
      'civitai-prod'
    ).catch(() => undefined);

    if (knownPreMoney) {
      // No money moved, so the claim is released — a genuine retry (once the
      // viewer has topped up) must be able to buy this good.
      await releaseUnsettledClaim(purchaseId);
      return {
        ok: false,
        status: 400,
        reason: 'insufficient_funds',
        error: 'You do not have enough Buzz to buy this item',
      };
    }

    // 🔴 UNKNOWN OUTCOME. The `pending` row SURVIVES: it is the only record that
    // a debit may exist. A 5xx also keeps the caller's daily-cap reservation
    // (the endpoint only refunds on a 4xx), which is the safe direction.
    return {
      ok: false,
      status: 503,
      reason: 'charge_unknown',
      error: 'Could not confirm this purchase. Please check your balance before retrying.',
    };
  }

  // A partially-fulfilled debit must not be recorded as a full-price sale, or
  // the owner is paid 70% of Buzz the viewer never spent. `transactionCount`
  // alone does not say that — the total does.
  if (!transaction.transactionCount || transaction.totalAmount !== priceBuzz) {
    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: 'error',
        message: 'purchase charge did not fully land',
        appBlockId,
        goodId,
        buyerUserId,
        purchaseId,
        priceBuzz,
        chargedTotal: transaction.totalAmount,
        transactionCount: transaction.transactionCount,
      },
      'civitai-prod'
    ).catch(() => undefined);
    // Safe to reverse the whole prefix: this attempt is the exclusive holder of
    // the key, so no other attempt's money can be under it.
    await rollbackCharge(transactionId, good.title);
    await releaseUnsettledClaim(purchaseId);
    return {
      ok: false,
      status: 400,
      reason: 'charge_failed',
      error: 'Could not complete this purchase',
    };
  }

  const bluePaidBuzz = transaction.transactionIds
    .filter((t) => t.accountType === 'blue')
    .reduce((sum, t) => sum + t.amount, 0);

  // ── STEP 4. SETTLE: flip the claim to `paid` and grant the entitlement. ─────
  let entitlement: SerializedEntitlement;
  try {
    entitlement = await dbWrite.$transaction(async (tx) => {
      await tx.blockGoodPurchase.update({
        where: { id: purchaseId },
        data: { status: PURCHASE_STATUS_PAID, bluePaidBuzz },
      });

      // A revoked entitlement is re-granted rather than duplicated: the unique
      // key is (viewer, app, good), so re-buying after a refund updates the row
      // the refund revoked and the pair stays one-to-one with the new purchase.
      const row = await tx.blockGoodEntitlement.upsert({
        where: { userId_appBlockId_goodId: { userId: buyerUserId, appBlockId, goodId } },
        create: {
          id: newBlockGoodEntitlementId(),
          userId: buyerUserId,
          appBlockId,
          goodId,
          kind: good.kind,
          payload: good.payload as Prisma.InputJsonValue,
          purchaseId,
        },
        update: {
          kind: good.kind,
          payload: good.payload as Prisma.InputJsonValue,
          purchaseId,
          grantedAt: new Date(),
          revokedAt: null,
          revokeReason: null,
        },
        select: { goodId: true, kind: true, payload: true, grantedAt: true },
      });

      return serializeEntitlement(row);
    });
  } catch (error) {
    // The charge landed and the grant did not. Reverse the charge — unambiguous,
    // because this attempt holds the key exclusively — and release the claim so
    // a retry can buy the good.
    await rollbackCharge(transactionId, good.title);
    await releaseUnsettledClaim(purchaseId);
    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: 'error',
        message: 'purchase settle failed after a successful charge',
        appBlockId,
        goodId,
        buyerUserId,
        purchaseId,
        error: messageOf(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
    return {
      ok: false,
      status: 500,
      reason: 'charge_failed',
      error: 'Could not complete this purchase',
    };
  }

  // ── STEP 5. PAY THE OWNER. ─────────────────────────────────────────────────
  await payBlockGoodOwner({
    purchaseId,
    transactionId,
    appOwnerUserId,
    appOwnerShare,
    bluePaidBuzz,
    priceBuzz,
    domainColor: domainColorOf(payWith),
    title: good.title,
    buyerUserId,
  });

  return { ok: true, status: 200, purchaseId, goodId, priceBuzz, entitlement };
}

/**
 * Reverse this attempt's charge. Safe as a PREFIX-wide reversal only because the
 * caller holds the `buzz_transaction_id` claim exclusively — see the ordering
 * argument on `purchaseBlockGood`. Never throws: a failed reversal is logged and
 * left for reconciliation, because the alternative is failing a response after
 * the money has already moved.
 */
async function rollbackCharge(transactionId: string, title: string): Promise<void> {
  await refundMultiAccountTransaction({
    externalTransactionIdPrefix: transactionId,
    description: `Failed app item purchase - ${title}`.slice(0, 100),
  }).catch((error) => {
    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: 'error',
        message: 'purchase rollback refund failed',
        transactionId,
        error: messageOf(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
  });
}

/**
 * Delete an UNSETTLED claim row, freeing its deterministic key for a genuine
 * retry.
 *
 * 🔴 Guarded on `status = 'pending'`, so it can never delete a settled purchase
 * — that row is financial history. Called only where the charge is KNOWN not to
 * stand: a pre-money refusal, a partial debit that was reversed, or a grant that
 * failed and was reversed. It is deliberately NOT called on an UNKNOWN charge
 * outcome; see `purchaseBlockGood`.
 */
async function releaseUnsettledClaim(purchaseId: string): Promise<void> {
  await dbWrite.blockGoodPurchase
    .deleteMany({ where: { id: purchaseId, status: PURCHASE_STATUS_PENDING } })
    .catch((error) => {
      void logToAxiom(
        {
          name: BLOCK_GOODS_LOG_NAME,
          type: 'error',
          message: 'could not release an unsettled purchase claim',
          purchaseId,
          error: messageOf(error),
        },
        'civitai-prod'
      ).catch(() => undefined);
    });
}

/**
 * 🔴 GOODS REVENUE IS INVISIBLE TO THE EXISTING APP-EARNINGS SURFACES, and that
 * is a known gap. `getRevenueForOwner` / `getAppEarnings` / `blocks.getMyApps`
 * all aggregate `BlockBuzzAttribution`; this rail records into
 * `block_good_purchase.payouts` and writes no attribution row.
 * `recordSpendAttribution` is workflow-anchored so it is not a drop-in. Until
 * something bridges them, an owner's earnings page shows generation revenue and
 * not sales.
 *
 * Credit the app owner and RECORD what was actually paid, per colour, with each
 * leg's ledger transaction id. The record is what makes a refund a true
 * reversal of this payout rather than a fresh charge computed from today's
 * split.
 *
 * Never throws: the viewer has their entitlement, and a failed credit is an
 * obligation to re-run, not a reason to fail a completed purchase. A purchase
 * whose `payouts` is empty is exactly the set to re-run.
 */
async function payBlockGoodOwner(args: {
  purchaseId: string;
  transactionId: string;
  appOwnerUserId: number;
  appOwnerShare: number;
  bluePaidBuzz: number;
  priceBuzz: number;
  domainColor: BuzzAccountType;
  title: string;
  buyerUserId: number;
}): Promise<void> {
  const blueAmount = blueLegOfPayout({
    recipientAmount: args.appOwnerShare,
    bluePaid: args.bluePaidBuzz,
    priceBuzz: args.priceBuzz,
  });
  const legs: { amount: number; color: BuzzAccountType }[] = (
    [
      { amount: blueAmount, color: 'blue' as BuzzAccountType },
      { amount: args.appOwnerShare - blueAmount, color: args.domainColor },
    ] satisfies { amount: number; color: BuzzAccountType }[]
  ).filter((leg) => leg.amount > 0);

  try {
    // Retried like the cosmetic shop's distribute-funds block: one transient Buzz
    // blip would otherwise leave `payouts: []` and an unpaid obligation with no
    // re-runner. Each leg carries its own `externalTransactionId`, so a retry
    // after a partial success is deduped by the ledger rather than double-paying.
    await withRetries(async () => {
      const paid: BlockGoodPayout[] = [];
      for (const leg of legs) {
        const { transactionId } = await createBuzzTransaction({
          fromAccountId: 0,
          toAccountId: args.appOwnerUserId,
          toAccountType: leg.color,
          amount: leg.amount,
          type: TransactionType.Sell,
          description: `A user bought your app item - ${args.title}`.slice(0, 100),
          // Unique per recipient AND colour, so the two legs of one payout can
          // never collide on the same external id.
          externalTransactionId: `${args.transactionId}:sell:${args.appOwnerUserId}:${leg.color}`,
          details: { purchasedBy: args.buyerUserId, originalAmount: args.priceBuzz },
        });
        paid.push({
          userId: args.appOwnerUserId,
          amount: leg.amount,
          color: leg.color,
          ...(transactionId ? { transactionId } : {}),
        });
      }

      await dbWrite.blockGoodPurchase.update({
        where: { id: args.purchaseId },
        data: { payouts: paid },
      });
    }, 3);
  } catch (error) {
    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: 'error',
        message: 'owner payout failed',
        purchaseId: args.purchaseId,
        appOwnerUserId: args.appOwnerUserId,
        error: messageOf(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
  }
}

/** The non-blue colour the buyer paid from; what the owner's remainder is paid in. */
function domainColorOf(payWith: BuzzAccountType[]): BuzzAccountType {
  return payWith.find((color) => color !== 'blue') ?? 'yellow';
}

export type ListBlockGoodEntitlementsArgs = {
  userId: number;
  /** From `claims.appBlockId` — the ONLY app an entitlement read can see. */
  appBlockId: string;
  limit?: number;
};

/**
 * What this viewer owns FROM THIS APP. Scoped by `appBlockId` in the query
 * itself, so an app can never read an entitlement it did not sell — the reply
 * is its own sales ledger filtered to one viewer.
 *
 * Revoked entitlements are excluded: "what do I own" must not include what was
 * refunded. The rows are kept for audit, not for this read.
 */
export async function listBlockGoodEntitlements(
  args: ListBlockGoodEntitlementsArgs
): Promise<SerializedEntitlement[]> {
  const rows = await dbRead.blockGoodEntitlement.findMany({
    where: { userId: args.userId, appBlockId: args.appBlockId, revokedAt: null },
    select: { goodId: true, kind: true, payload: true, grantedAt: true },
    orderBy: { grantedAt: 'desc' },
    take: args.limit ?? 200,
  });
  return rows.map(serializeEntitlement);
}

export type RefundBlockGoodResult =
  | { refunded: true; buyerRefundedBuzz: number; clawedBackBuzz: number; failures: string[] }
  | { refunded: false; reason: 'not_found' | 'already_refunded' | 'buyer_refund_failed' };

/**
 * Reverse a purchase: refund the buyer and claw the owner's earnings back.
 *
 * 🔴 THE CLAWBACK READS `payouts`, NEVER A RE-DERIVED SPLIT. Refunding each
 * recorded payout transaction by id is the exact reversal of what the owner
 * received. Re-deriving `computeBlockGoodSplit(price)` would claw back today's
 * number, which can differ from what was paid — a colour proration that floored
 * differently, or a share constant that has since moved — and the error lands
 * on a real person's balance.
 *
 * A payout recorded WITHOUT a transaction id (the credit leg never reported
 * one) cannot be reversed this way and is reported in `failures` for a human,
 * rather than being replaced by a guess.
 */
export async function refundBlockGoodPurchase(args: {
  purchaseId: string;
  reason: string;
}): Promise<RefundBlockGoodResult> {
  const purchase = await dbWrite.blockGoodPurchase.findUnique({
    where: { id: args.purchaseId },
    select: {
      id: true,
      status: true,
      userId: true,
      appBlockId: true,
      goodId: true,
      priceBuzz: true,
      buzzTransactionId: true,
      payouts: true,
    },
  });
  if (!purchase) return { refunded: false, reason: 'not_found' };
  if (purchase.status === PURCHASE_STATUS_REFUNDED)
    return { refunded: false, reason: 'already_refunded' };

  const failures: string[] = [];

  // 🔴 THE BUYER IS REFUNDED FIRST, AND A FAILURE HERE ABORTS THE WHOLE REVERSAL.
  // Marking the row `refunded` after a failed buyer refund is the worst outcome
  // this function can produce: the viewer loses the item AND keeps no money, the
  // row asserts they were repaid, and `already_refunded` then refuses every
  // retry — so the remediation path is closed by the record of the failure. It
  // returns early instead, leaving the purchase `paid` and the entitlement
  // intact, which is a state a retry can act on.
  let buyerRefundedBuzz = 0;
  try {
    const refund = await refundMultiAccountTransaction({
      externalTransactionIdPrefix: purchase.buzzTransactionId,
      description: `App item refunded - ${args.reason}`.slice(0, 100),
    });
    buyerRefundedBuzz = refund.totalRefunded;
  } catch (error) {
    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: 'error',
        message: 'refund ABORTED — the buyer was not repaid',
        purchaseId: purchase.id,
        error: messageOf(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
    return { refunded: false, reason: 'buyer_refund_failed' };
  }

  let clawedBackBuzz = 0;
  for (const payout of readRecordedPayouts(purchase.payouts)) {
    if (payout.amount <= 0) continue;
    if (!payout.transactionId) {
      failures.push(
        `payout to user ${payout.userId} of ${payout.amount} ${payout.color} has no recorded transaction id`
      );
      continue;
    }
    try {
      await refundTransaction(payout.transactionId, `App item refunded - ${args.reason}`);
      clawedBackBuzz += payout.amount;
    } catch (error) {
      failures.push(
        `clawback of ${payout.amount} ${payout.color} from user ${payout.userId} failed: ${
          messageOf(error) ?? 'unknown error'
        }`
      );
    }
  }

  await dbWrite.$transaction(async (tx) => {
    await tx.blockGoodPurchase.update({
      where: { id: purchase.id },
      data: {
        status: PURCHASE_STATUS_REFUNDED,
        refundReason: args.reason,
        refundedAt: new Date(),
      },
    });
    await tx.blockGoodEntitlement.updateMany({
      where: { purchaseId: purchase.id, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: args.reason },
    });
  });

  if (failures.length > 0) {
    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: 'error',
        message: 'refund completed with failures',
        purchaseId: purchase.id,
        failures,
      },
      'civitai-prod'
    ).catch(() => undefined);
  }

  return { refunded: true, buyerRefundedBuzz, clawedBackBuzz, failures };
}

/**
 * Narrow the `payouts` JSON column back to the shape the purchase path wrote.
 * It is read off the database as `unknown`, and a refund is money, so every
 * field is checked rather than cast.
 */
export function readRecordedPayouts(raw: unknown): BlockGoodPayout[] {
  if (!Array.isArray(raw)) return [];
  const out: BlockGoodPayout[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { userId, amount, color, transactionId } = entry as Record<string, unknown>;
    if (typeof userId !== 'number' || typeof amount !== 'number' || typeof color !== 'string')
      continue;
    out.push({
      userId,
      amount,
      color: color as BuzzAccountType,
      ...(typeof transactionId === 'string' && transactionId.length > 0 ? { transactionId } : {}),
    });
  }
  return out;
}

/**
 * Detected by CODE rather than `instanceof`, deliberately: the branch must stay
 * reachable under a mocked Prisma client, which does not construct the real
 * error class. Mirrors `author-fee-accrual.service.ts`.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function messageOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return undefined;
}
