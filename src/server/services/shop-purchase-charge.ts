import { isSafeToRetry } from '@civitai/buzz';
import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';
import { isPrismaUniqueViolation, throwBadRequestError } from '~/server/utils/errorHandling';

/**
 * Charging for a shop purchase whose external transaction id may have been used
 * before (a client resending its idempotency key).
 *
 * Every purchase first CLAIMS its charge prefix with a `CosmeticShopPurchaseClaim`
 * row, before any money moves. The claim, not the ledger's answer, decides what
 * a charge under a reused prefix means:
 *
 *   pending    an attempt reached the charge and its outcome is not settled.
 *              A retry under the same key resumes it, at the claimed amount.
 *   paid       granted. A retry is told the purchase is already complete.
 *   refunding  a refund was started and has not been confirmed. Nothing more
 *              happens under this key until someone reconciles it.
 *   refunded   the charge was reversed. A retry is refused; the client starts
 *              a new purchase with a new key.
 *
 * A claim refused by the ledger before any transaction existed is deleted, so
 * the key stays usable.
 *
 * The ledger answers an external id it has already seen with a 200 whose legs
 * are marked `duplicate` (see the measured note in block-goods.service.ts). Such
 * legs are granted against only when they belong to an earlier attempt of THIS
 * claim (it was pending before this request) and cover the claimed amount.
 * Anything else, including a 409, is "state unknown": no grant, payout or
 * refund. Ordinary declines are 400s and pass through as refusals.
 *
 * The outcome is reported as unknown, never as a refusal: a 4xx tells the client
 * nothing was charged and to retry with a fresh key.
 */

export const PURCHASE_STATE_UNKNOWN_MESSAGE =
  "We couldn't confirm this purchase. Check your cosmetics before trying again.";

/** The Axiom event name for a purchase that needs reconciling by hand. */
export const PURCHASE_STATE_UNKNOWN_LOG_NAME = 'shop-purchase-state-unknown';

export const PURCHASE_ALREADY_COMPLETED_MESSAGE = 'This purchase has already been completed';

export const SHOP_PURCHASE_CLAIM_STATUS = {
  pending: 'pending',
  refunding: 'refunding',
  refunded: 'refunded',
  paid: 'paid',
} as const;
const CLAIM = SHOP_PURCHASE_CLAIM_STATUS;

export type ShopChargeContext = {
  userId: number;
  shopItemId: number;
  /** The charge's external transaction id prefix. */
  transactionId: string;
  amount: number;
};

/**
 * The purchase may or may not have been paid for, and nothing was granted. Each
 * one needs reconciling by hand (grant or refund), so it is logged as its own
 * event with everything needed to find the charge.
 */
export function purchaseStateUnknown(
  context: ShopChargeContext & { error?: unknown; refundError?: unknown },
  reason: string
) {
  const { error, refundError, ...ids } = context;
  logToAxiom({
    name: PURCHASE_STATE_UNKNOWN_LOG_NAME,
    type: 'error',
    message: 'shop purchase state unknown',
    reason,
    ...ids,
    error: error instanceof Error ? error.message : error,
    refundError: refundError instanceof Error ? refundError.message : refundError,
  });
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: PURCHASE_STATE_UNKNOWN_MESSAGE });
}

export type ShopPurchaseClaim = {
  transactionId: string;
  /** What to charge: the claimed amount, which on a resumed claim may differ from today's price. */
  amount: number;
  /** True when an earlier request wrote this claim and left it pending. */
  resumed: boolean;
};

/**
 * Claims `transactionId` for this purchase before it is charged. Resolves with
 * the claim to charge under, or throws the answer for a key that is already
 * settled. `amount` is only used when the claim is new.
 */
export async function claimShopPurchase(context: ShopChargeContext): Promise<ShopPurchaseClaim> {
  const { transactionId, userId, shopItemId, amount } = context;
  try {
    await dbWrite.cosmeticShopPurchaseClaim.create({
      data: { transactionId, userId, shopItemId, amount, status: CLAIM.pending },
    });
    return { transactionId, amount, resumed: false };
  } catch (error) {
    if (!isPrismaUniqueViolation(error)) throw error;
  }

  const existing = await dbWrite.cosmeticShopPurchaseClaim.findUnique({
    where: { transactionId },
    select: { userId: true, shopItemId: true, amount: true, status: true },
  });
  // Deleted between the insert and this read: another attempt under this key
  // was declined, so nothing is charged under it.
  if (!existing) throw throwBadRequestError('This purchase could not be started. Try again.');
  // The prefix names the buyer and the item, so this is not reachable through a
  // client key. Refused rather than charged under someone else's claim.
  if (existing.userId !== userId || existing.shopItemId !== shopItemId)
    throw throwBadRequestError('This purchase is not available');

  switch (existing.status) {
    case CLAIM.pending: {
      // Counted so the request that created the claim cannot release it on a
      // decline while this one may be charging under it (see releaseClaim).
      const { count } = await dbWrite.cosmeticShopPurchaseClaim.updateMany({
        where: { transactionId, status: CLAIM.pending },
        data: { attempts: { increment: 1 } },
      });
      // Settled or released since the read: nothing is charged from here, and
      // the next retry reads the settled status.
      if (count !== 1)
        throw purchaseStateUnknown(
          { ...context, amount: existing.amount },
          'claim changed on resume'
        );
      return { transactionId, amount: existing.amount, resumed: true };
    }
    case CLAIM.paid:
      throw throwBadRequestError(PURCHASE_ALREADY_COMPLETED_MESSAGE);
    case CLAIM.refunded:
      throw throwBadRequestError('This purchase was refunded. Start a new purchase to buy it.');
    default:
      // `refunding`: whether the money came back is not known, so neither
      // "nothing was charged" nor a new charge is safe.
      throw purchaseStateUnknown(
        { ...context, amount: existing.amount },
        `retry of a ${existing.status} claim`
      );
  }
}

// The buzz client retries every failure by default, including ones where the
// first attempt may have landed. Its resend would then come back as this
// request's own duplicate. Only a failure that never reached the ledger is
// retried.
export const chargeRetryOptions = { shouldRetry: isSafeToRetry };

// A refund is sent once. The client may resend it only when the connection
// never opened (nothing reached the ledger); each attempt has a deadline, since
// a purchase request waits on this before it answers.
export const refundCallOptions = { retries: 1, shouldRetry: isSafeToRetry, timeoutMs: 10_000 };

type Charge = {
  transactionIds: { duplicate?: boolean; amount: number }[];
  transactionCount: number;
};

// A ledger 4xx that created nothing. 408 and 409 are not: the first may have
// landed, the second means the id is taken.
const isDecline = (status: number | undefined) =>
  status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 409;

export async function chargeForShopPurchase<T extends Charge>(
  charge: () => Promise<T>,
  context: ShopChargeContext,
  claim: ShopPurchaseClaim
): Promise<T> {
  let result: T;
  try {
    result = await charge();
  } catch (error) {
    const status = getBuzzApiStatus(error);
    if (status === 409)
      throw purchaseStateUnknown({ ...context, error }, 'ledger reported the id as taken');
    // Only a claim no other request has resumed is released: see releaseClaim.
    if (isDecline(status)) await releaseClaim(context);
    throw error;
  }

  const duplicates = result.transactionIds.filter((leg) => leg.duplicate === true);
  if (!duplicates.length) return result;

  // Only an earlier attempt of this same pending claim may have charged under
  // this prefix, so a replay of it is that attempt's money. A claim made by this
  // request has no earlier attempt to own them, and a mix of new and duplicate
  // legs moved some money now, which a prefix refund would reverse along with
  // the earlier legs.
  const coversClaim =
    duplicates.length === result.transactionIds.length &&
    duplicates.reduce((sum, leg) => sum + leg.amount, 0) >= context.amount;
  if (claim.resumed && coversClaim) return result;
  throw purchaseStateUnknown(context, 'ledger returned duplicate legs');
}

async function releaseClaim(context: ShopChargeContext) {
  try {
    // `attempts: 1`: a request that resumed this claim may have charged under it
    // before this one was declined, and its charge needs the claim to settle.
    await dbWrite.cosmeticShopPurchaseClaim.deleteMany({
      where: { transactionId: context.transactionId, status: CLAIM.pending, attempts: 1 },
    });
  } catch (error) {
    // Left pending, a retry resumes it and the ledger declines again; nothing
    // is lost by not deleting it.
    logToAxiom({
      type: 'error',
      name: 'shop-purchase-claim',
      message: 'Failed to release a declined claim',
      ...context,
      error: error instanceof Error ? error.message : error,
    });
  }
}

/**
 * Thrown inside a grant transaction whose claim another attempt already settled.
 * It rolls the grant back and reaches the caller's refund path, where
 * refundClaimedCharge finds the claim not pending and answers without refunding.
 */
class ShopPurchaseClaimSettledError extends Error {
  constructor() {
    super('shop purchase claim is no longer pending');
  }
}

/**
 * Marks the claim paid. Call FIRST in the grant transaction: the row lock it
 * takes is what makes a concurrent grant of the same claim wait, then find it
 * settled and roll back.
 */
export async function markClaimPaid(tx: Prisma.TransactionClient, transactionId: string) {
  const { count } = await tx.cosmeticShopPurchaseClaim.updateMany({
    where: { transactionId, status: CLAIM.pending },
    data: { status: CLAIM.paid },
  });
  if (count !== 1) throw new ShopPurchaseClaimSettledError();
}

/**
 * The answer for an attempt whose claim another attempt settled first: granted
 * means the buyer has it; anything else is that attempt's to finish.
 */
async function claimSettledElsewhere(context: ShopChargeContext & { error?: unknown }) {
  const claim = await dbWrite.cosmeticShopPurchaseClaim.findUnique({
    where: { transactionId: context.transactionId },
    select: { status: true },
  });
  if (claim?.status === CLAIM.paid) return throwBadRequestError(PURCHASE_ALREADY_COMPLETED_MESSAGE);
  return purchaseStateUnknown(context, `claim settled elsewhere as ${claim?.status ?? 'missing'}`);
}

/**
 * Reverses a claimed charge after a failed grant. Resolves only when the ledger
 * reports the whole amount back, so the caller may answer with a refusal.
 *
 * The claim is marked `refunding` BEFORE the refund is sent. A refund that lands
 * with its response lost must never leave the claim `pending`: a retry would
 * then read the reversed legs as its earlier attempt's charge and grant.
 */
export async function refundClaimedCharge(
  refund: () => Promise<{ totalRefunded: number } | null | undefined>,
  context: ShopChargeContext & { error?: unknown }
) {
  let marked: number;
  try {
    ({ count: marked } = await dbWrite.cosmeticShopPurchaseClaim.updateMany({
      where: { transactionId: context.transactionId, status: CLAIM.pending },
      data: { status: CLAIM.refunding },
    }));
  } catch (markError) {
    throw purchaseStateUnknown(
      { ...context, refundError: markError },
      'claim not marked refunding'
    );
  }
  // Another attempt of this claim settled it: the charge is theirs.
  if (marked !== 1) throw await claimSettledElsewhere(context);

  await refundShopCharge(refund, context);

  try {
    await dbWrite.cosmeticShopPurchaseClaim.update({
      where: { transactionId: context.transactionId },
      data: { status: CLAIM.refunded },
    });
  } catch (error) {
    // The money is back. Left `refunding`, a retry is answered "unknown" rather
    // than charged, and reconciliation finds the refunded charge.
    logToAxiom({
      type: 'error',
      name: 'shop-purchase-claim',
      message: 'Refunded, but the claim was not marked refunded',
      ...context,
      error: error instanceof Error ? error.message : error,
    });
  }
}

/**
 * Reverses this request's charge. Resolves only when the ledger reports the
 * whole amount back. Every other outcome (an error of any kind, a 409, a short
 * or missing total) is "state unknown": the refund is not resent from here, and
 * the purchase is left to reconciliation through the logged event.
 */
export async function refundShopCharge(
  refund: () => Promise<{ totalRefunded: number } | null | undefined>,
  context: ShopChargeContext & { error?: unknown }
) {
  let refunded: { totalRefunded: number } | null | undefined;
  try {
    refunded = await refund();
  } catch (refundError) {
    throw purchaseStateUnknown({ ...context, refundError }, 'refund failed');
  }
  // Not `<`: a missing total must never read as covered.
  if (!refunded || !(refunded.totalRefunded >= context.amount))
    throw purchaseStateUnknown(context, 'refund did not cover the charge');
}
