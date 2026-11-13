import { KEY_VALUE_KEYS } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { dbKV } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import type { CreatorCosmeticType, CreatorShopFees } from '~/server/schema/creator-shop.schema';
import { normalizeCreatorShopFees } from '~/server/schema/creator-shop.schema';
import type { Prisma } from '@prisma/client';
import {
  CHARGE_LOCKED_READ,
  CHARGE_LOCKED_REFUND,
  recordStepError,
  refundUnlessRecorded,
  withChargeKeyLock,
} from '~/server/services/buzz-charge-lock';
import {
  chargeByExternalId,
  PAYMENT_REFUNDED_MESSAGE,
  paymentOutcomeUnknown,
} from '~/server/services/buzz-keyed-charge';
import { getTransactionByExternalId, refundTransaction } from '~/server/services/buzz.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';

/**
 * A read failure is deliberately NOT swallowed into the defaults. The fee is charged
 * before review and is non-refundable, so falling back while the row says something
 * lower would charge more than the form quoted; failing the submission instead moves
 * no money. Absent or malformed values still fall back, per value.
 */
export async function getCreatorShopFees(): Promise<CreatorShopFees> {
  return normalizeCreatorShopFees(await dbKV.get(KEY_VALUE_KEYS.CREATOR_SHOP_FEES));
}

export async function getCreatorShopSubmissionFee(type: CreatorCosmeticType): Promise<number> {
  return (await getCreatorShopFees()).submission[type];
}

/**
 * Refuses a submission whose form quoted a different fee than the one about to be
 * charged. Charging either number silently is wrong: the low one under-collects,
 * the high one takes Buzz the creator never agreed to and never gets it back.
 */
export function assertQuotedFee(quotedFee: number, actualFee: number) {
  if (quotedFee === actualFee) return;
  throw throwBadRequestError(
    `The submission fee changed to ${actualFee} Buzz while this form was open. Close and reopen it to continue.`
  );
}

const SUBMISSION_FEE_PREFIX = {
  item: 'creator-shop-submit',
  pack: 'creator-shop-pack-submit',
  mysteryPack: 'creator-shop-mystery-pack-submit',
} as const;
export type SubmissionFeeKind = keyof typeof SUBMISSION_FEE_PREFIX;

/**
 * The fee charge's external id for one submission. With the client's key (a uuid, minted once per
 * submission and resent on its retries) it is the same on every retry, so the ledger holds one
 * charge for it. The user id comes first and has no '-', so one user's key never names another
 * user's charge. Without a key (a client from before keys), a new id per call, as before.
 */
export function submissionFeeTransactionId(
  kind: SubmissionFeeKind,
  userId: number,
  idempotencyKey: string | undefined
) {
  return `${SUBMISSION_FEE_PREFIX[kind]}-${userId}-${idempotencyKey ?? Date.now()}`;
}

export const SUBMISSION_ALREADY_COMPLETED_MESSAGE =
  'This submission was already completed. Reload to see it, or start a new submission.';

/**
 * Charges a submission fee once per submission and runs `write` (the listing's inserts) against it,
 * refunding the fee if `write` fails. `write` gets the transaction its inserts must use and the
 * fee's ledger transaction id.
 *
 * Without a key (a client from before keys): charged under a new id, then `write` in its own
 * transaction, as before.
 *
 * With a key:
 * - the charge is chargeByExternalId's, outside any transaction: a fee the ledger already holds
 *   under the key is this submission's, continued from without a balance check;
 * - then, under the key's lock (buzz-charge-lock.ts) in a short transaction that `write` also uses:
 *   a fee already recorded on a listing paid for that listing (a lost response, a concurrent
 *   request, or other content under a reused key), so this submission is refused; a refunded fee
 *   is refused; otherwise the listing is written;
 * - a failed write refunds the fee unless another request recorded it meanwhile.
 */
export async function withSubmissionFee<T>(
  {
    kind,
    userId,
    buzzType,
    amount,
    description,
    refundDescription,
    idempotencyKey,
  }: {
    kind: SubmissionFeeKind;
    userId: number;
    buzzType: BuzzSpendType;
    amount: number;
    description: string;
    refundDescription: string;
    idempotencyKey: string | undefined;
  },
  write: (tx: Prisma.TransactionClient, feeTxId: string) => Promise<T>
): Promise<T> {
  const externalTransactionId = submissionFeeTransactionId(kind, userId, idempotencyKey);
  const fee = {
    fromAccountId: userId,
    fromAccountType: buzzType,
    toAccountId: 0,
    amount,
    type: TransactionType.Purchase,
    description,
    externalTransactionId,
  };
  const declinedMessage = 'Unable to charge the submission fee';

  if (idempotencyKey === undefined) {
    const { transactionId } = await chargeByExternalId(fee, { reusable: false, declinedMessage });
    try {
      return await dbWrite.$transaction((tx) => write(tx, transactionId));
    } catch (error) {
      await refundTransaction(transactionId, refundDescription);
      throw error;
    }
  }

  const { transactionId } = await chargeByExternalId(fee, { reusable: true, declinedMessage });
  const context = { userId, amount };
  // Item, pack and mystery pack listings all record their fee in CosmeticShopItem.meta, and are
  // all the submitter's own (`addedById`).
  const isListed = async (tx: Prisma.TransactionClient) =>
    (
      await tx.$queryRaw<{ id: number }[]>`
        SELECT id FROM "CosmeticShopItem"
        WHERE "addedById" = ${userId} AND meta->>'submissionTxId' = ${transactionId}
        LIMIT 1`
    ).length > 0;
  const isRefunded = async () =>
    !!(await getTransactionByExternalId(`refund-${transactionId}`, CHARGE_LOCKED_READ));

  let writeFailed = false;
  try {
    return await withChargeKeyLock(externalTransactionId, context, async (tx) => {
      if (await isListed(tx)) throw throwBadRequestError(SUBMISSION_ALREADY_COMPLETED_MESSAGE);
      let refunded: boolean;
      try {
        refunded = await isRefunded();
      } catch (lookupError) {
        throw paymentOutcomeUnknown(
          { externalTransactionId, ...context },
          'refund check before recording failed',
          { lookupError }
        );
      }
      if (refunded) throw throwBadRequestError(PAYMENT_REFUNDED_MESSAGE);
      try {
        return await write(tx, transactionId);
      } catch (error) {
        writeFailed = true;
        throw error;
      }
    });
  } catch (error) {
    if (writeFailed)
      await refundUnlessRecorded(externalTransactionId, context, {
        isRecorded: isListed,
        isRefunded,
        refund: () =>
          refundTransaction(transactionId, refundDescription, undefined, CHARGE_LOCKED_REFUND),
      });
    // A failed write was refunded (or left to the request that recorded it): the write's own
    // error. Anything else after the charge: recordStepError.
    if (writeFailed) throw error;
    throw recordStepError(error, { externalTransactionId, ...context });
  }
}

export type CreatorShopFeesInput = {
  submission?: Partial<Record<string, number>>;
  pack?: number;
  mysteryPack?: number;
};

// Read-before-write (dbKV reads the primary) so setting one type's fee can't drop the rest.
export async function setCreatorShopFees(
  input: CreatorShopFeesInput,
  { actorId }: { actorId?: number } = {}
): Promise<CreatorShopFees> {
  const current = await getCreatorShopFees();
  const next = normalizeCreatorShopFees({
    submission: { ...current.submission, ...input.submission },
    pack: input.pack ?? current.pack,
    mysteryPack: input.mysteryPack ?? current.mysteryPack,
  });
  await dbKV.set(KEY_VALUE_KEYS.CREATOR_SHOP_FEES, next);
  // A log failure must not fail the caller: the row is already changed, and a 500 here
  // invites a retry whose `previous` is the new value.
  await logToAxiom({
    type: 'info',
    name: 'set-creator-shop-fees',
    actorId,
    previous: current,
    next,
  }).catch(() => undefined);
  return next;
}
