import { KEY_VALUE_KEYS } from '~/server/common/constants';
import { dbWrite } from '~/server/db/client';
import { dbKV } from '~/server/db/db-helpers';
import { logToAxiom } from '~/server/logging/client';
import type { CreatorCosmeticType, CreatorShopFees } from '~/server/schema/creator-shop.schema';
import { normalizeCreatorShopFees } from '~/server/schema/creator-shop.schema';
import { chargeByExternalId } from '~/server/services/buzz-keyed-charge';
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
 * Charges a submission fee once per submission: see chargeByExternalId. With a key, the charge the
 * ledger answers may be one an earlier request under the same key already turned into a listing
 * (that request's response was lost, or the client reused the key for other content). That charge
 * paid for that listing, so this submission is refused rather than listed on it.
 */
export async function chargeSubmissionFee({
  kind,
  userId,
  buzzType,
  amount,
  description,
  idempotencyKey,
}: {
  kind: SubmissionFeeKind;
  userId: number;
  buzzType: BuzzSpendType;
  amount: number;
  description: string;
  idempotencyKey: string | undefined;
}) {
  const charge = await chargeByExternalId(
    {
      fromAccountId: userId,
      fromAccountType: buzzType,
      toAccountId: 0,
      amount,
      type: TransactionType.Purchase,
      description,
      externalTransactionId: submissionFeeTransactionId(kind, userId, idempotencyKey),
    },
    { reusable: idempotencyKey !== undefined }
  );
  if (idempotencyKey === undefined) return charge;

  // Item, pack and mystery pack listings all record their fee here (CosmeticShopItem.meta).
  const listed = await dbWrite.cosmeticShopItem.findFirst({
    where: { meta: { path: ['submissionTxId'], equals: charge.transactionId } },
    select: { id: true },
  });
  if (listed) throw throwBadRequestError(SUBMISSION_ALREADY_COMPLETED_MESSAGE);
  return charge;
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
