import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  createBuzzTransaction,
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
  refundTransaction,
} from '~/server/services/buzz.service';
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

const APP_BLOCK_APPROVED_STATUS = 'approved';
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
  | { ok: false; status: number; error: string; code: PurchaseRefusalCode };

export type PurchaseRefusalCode =
  | 'app_not_found'
  | 'good_not_found'
  | 'price_changed'
  | 'price_over_cap'
  | 'already_owned'
  | 'self_purchase'
  | 'insufficient_funds'
  | 'duplicate'
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
 * charge uniquely for all time. That makes the Buzz ledger's own
 * `externalTransactionId` uniqueness the authoritative dedupe: a retry after
 * every cache has expired still cannot move money twice. The client
 * `idempotencyKey` is a separate, faster layer (concurrency + verbatim replay)
 * and is deliberately NOT part of this string — folding it in would make two
 * different keys for one logical purchase and undo the guarantee.
 */
export function blockGoodPurchaseKey(args: {
  appBlockId: string;
  goodId: string;
  buyerUserId: number;
}): string {
  return `block-good:${args.appBlockId}:${args.goodId}:${args.buyerUserId}`;
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
 * Ordering is load-bearing:
 *   1. resolve everything server-side (no money, no writes)
 *   2. refuse the cases that must never charge (ownership, self-purchase, price)
 *   3. refuse a purchase already recorded under this key — the ledger-backed
 *      replay, checked BEFORE the charge so a retry is cheap
 *   4. charge the buyer
 *   5. write the purchase + entitlement in ONE transaction; a UNIQUE violation
 *      here means a concurrent attempt won, so refund OUR charge attempt and
 *      report a duplicate
 *   6. pay the owner, and record what was paid
 *
 * The payout (6) is deliberately AFTER the entitlement is durable and is
 * best-effort in the same sense the cosmetic shop's is: a viewer who paid must
 * get their entitlement even if the credit leg needs re-running. The difference
 * from a dropped metric is that the obligation is RECORDED — an unpaid purchase
 * has `payouts: []` and is findable.
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
      code: 'price_over_cap',
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
      code: 'price_changed',
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
      code: 'self_purchase',
      error: 'You cannot buy your own app’s items',
    };
  }

  const existingEntitlement = await dbRead.blockGoodEntitlement.findUnique({
    where: { userId_appBlockId_goodId: { userId: buyerUserId, appBlockId, goodId } },
    select: { goodId: true, kind: true, payload: true, grantedAt: true, revokedAt: true },
  });
  if (existingEntitlement && !existingEntitlement.revokedAt) {
    return {
      ok: false,
      status: 409,
      code: 'already_owned',
      error: 'You already own this item',
    };
  }

  const transactionId = blockGoodPurchaseKey({ appBlockId, goodId, buyerUserId });

  // Ledger-backed replay, checked before the charge so a retry costs one read.
  // The authoritative guard is the UNIQUE constraint this column carries plus
  // the Buzz ledger's own refusal of a repeated externalTransactionId — this is
  // the cheap path, not the safety.
  const alreadyPurchased = await dbWrite.blockGoodPurchase.findUnique({
    where: { buzzTransactionId: transactionId },
    select: { id: true },
  });
  if (alreadyPurchased) {
    return {
      ok: false,
      status: 409,
      code: 'duplicate',
      error: 'This purchase has already been completed',
    };
  }

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
    // Every pre-money refusal in the Buzz service is a bad-request: insufficient
    // funds is the one a viewer sees, and it must read as a clean 400, never a 500.
    //
    // 🔴 The caught message is LOGGED, never returned. A driver-authored string
    // on the wire is the civitai#3845 disclosure class, and the viewer-facing
    // half of it ("you do not have enough Buzz") is already implied by the code.
    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: 'warning',
        message: 'purchase charge refused',
        appBlockId,
        goodId,
        buyerUserId,
        detail: messageOf(error),
      },
      'civitai-prod'
    ).catch(() => undefined);
    return {
      ok: false,
      status: 400,
      code: 'insufficient_funds',
      error: 'You do not have enough Buzz to buy this item',
    };
  }

  if (!transaction.transactionCount) {
    return {
      ok: false,
      status: 400,
      code: 'charge_failed',
      error: 'Could not complete this purchase',
    };
  }

  const bluePaidBuzz = transaction.transactionIds
    .filter((t) => t.accountType === 'blue')
    .reduce((sum, t) => sum + t.amount, 0);
  const { appOwnerShare, platformShare } = computeBlockGoodSplit(priceBuzz);

  const purchaseId = newBlockGoodPurchaseId();
  let entitlement: SerializedEntitlement;
  try {
    entitlement = await dbWrite.$transaction(async (tx) => {
      await tx.blockGoodPurchase.create({
        data: {
          id: purchaseId,
          userId: buyerUserId,
          appId,
          appBlockId,
          blockInstanceId: input.blockInstanceId ?? null,
          goodId,
          manifestVersion,
          priceBuzz,
          bluePaidBuzz,
          appOwnerUserId,
          appOwnerShareBuzz: appOwnerShare,
          platformShareBuzz: platformShare,
          buzzTransactionId: transactionId,
          status: PURCHASE_STATUS_PAID,
        },
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
    // The charge landed and the ledger did not. Give the money back under the
    // same prefix — `refundMultiAccountTransaction` reverses every leg of it —
    // and report a duplicate if the reason we failed is that a concurrent
    // attempt already recorded this exact purchase.
    await refundMultiAccountTransaction({
      externalTransactionIdPrefix: transactionId,
      description: `Failed app item purchase - ${good.title}`.slice(0, 100),
    }).catch((refundError) => {
      void logToAxiom(
        {
          name: BLOCK_GOODS_LOG_NAME,
          type: 'error',
          message: 'purchase rollback refund failed',
          appBlockId,
          goodId,
          buyerUserId,
          transactionId,
          error: messageOf(refundError),
        },
        'civitai-prod'
      ).catch(() => undefined);
    });

    if (isUniqueViolation(error)) {
      return {
        ok: false,
        status: 409,
        code: 'duplicate',
        error: 'This purchase has already been completed',
      };
    }
    void logToAxiom(
      {
        name: BLOCK_GOODS_LOG_NAME,
        type: 'error',
        message: 'purchase ledger write failed',
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
      code: 'charge_failed',
      error: 'Could not complete this purchase',
    };
  }

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
  | { refunded: false; reason: 'not_found' | 'already_refunded' };

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

  let buyerRefundedBuzz = 0;
  try {
    const refund = await refundMultiAccountTransaction({
      externalTransactionIdPrefix: purchase.buzzTransactionId,
      description: `App item refunded - ${args.reason}`.slice(0, 100),
    });
    buyerRefundedBuzz = refund.totalRefunded;
  } catch (error) {
    failures.push(`buyer refund failed: ${messageOf(error) ?? 'unknown error'}`);
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
