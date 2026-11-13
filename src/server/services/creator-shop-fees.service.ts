import { KEY_VALUE_KEYS } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { dbKV } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import type { CreatorCosmeticType, CreatorShopFees } from '~/server/schema/creator-shop.schema';
import { normalizeCreatorShopFees } from '~/server/schema/creator-shop.schema';
import type { Prisma } from '@prisma/client';
import { CHARGE_WRITE_TIMEOUT_MS, withChargeKeyLock } from '~/server/services/buzz-charge-lock';
import { chargeByExternalId } from '~/server/services/buzz-keyed-charge';
import { refundTransaction } from '~/server/services/buzz.service';
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
 * With a key, all of it runs under the key's lock (buzz-charge-lock.ts), in the transaction `write`
 * gets, so a second request with the same key waits and then sees this one's listing or refund:
 * - the charge is chargeByExternalId's: a fee the ledger already holds under the key is this
 *   submission's, continued from without a balance check; a refunded one is refused;
 * - a held fee already recorded on a listing paid for that listing (the same content after a lost
 *   response, or other content under a reused key), so this submission is refused, not listed on it.
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

  return withChargeKeyLock(externalTransactionId, { userId, amount }, async (tx) => {
    const { transactionId } = await chargeByExternalId(fee, {
      reusable: true,
      timeoutMs: CHARGE_WRITE_TIMEOUT_MS,
      declinedMessage,
    });

    // Item, pack and mystery pack listings all record their fee here (CosmeticShopItem.meta).
    const listed = await tx.cosmeticShopItem.findFirst({
      where: { meta: { path: ['submissionTxId'], equals: transactionId } },
      select: { id: true },
    });
    if (listed) throw throwBadRequestError(SUBMISSION_ALREADY_COMPLETED_MESSAGE);

    try {
      return await write(tx, transactionId);
    } catch (error) {
      // Under the lock: a second request waiting on this key sees the refund, never a charge
      // this request is about to reverse.
      await refundTransaction(transactionId, refundDescription, undefined, {
        timeoutMs: CHARGE_WRITE_TIMEOUT_MS,
      });
      throw error;
    }
  });
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
