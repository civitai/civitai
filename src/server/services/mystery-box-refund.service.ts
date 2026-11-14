import { Prisma } from '@prisma/client';
import {
  BOX_OPENING_REWARD_STATUS,
  ITEM_TYPE,
  boxOpenClaimKey,
  boxPackTermsOf,
  packBoxSourceKey,
  packBoxSourcePrefix,
  parsePackBoxSourceKey,
} from '@civitai/shared/mystery-box';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  createBuzzTransaction,
  getMultiAccountTransactionsByPrefix,
} from '~/server/services/buzz.service';
import { revokeCosmeticsFromUsers } from '~/server/services/cosmetic.service';
import {
  readPurchaseLedger,
  reversePurchase,
} from '~/server/services/creator-shop-withdrawn-refund.service';
import { lockItemHolder } from '~/server/services/item-holder-lock';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';
import { withRetries } from '~/server/utils/errorHandling';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';
import { TransactionType } from '~/shared/constants/buzz.constants';

type Tx = Prisma.TransactionClient;

export const BOX_REFUND_REASONS = ['moderator', 'over-pool', 'box-takedown'] as const;
export type BoxRefundReason = (typeof BOX_REFUND_REASONS)[number];

export const BOX_REFUND_DESCRIPTIONS: Record<BoxRefundReason, string> = {
  moderator: 'Refund: mystery box purchase',
  'over-pool': 'Refund: mystery box that can no longer be opened',
  'box-takedown': 'Refund: mystery box removed',
};

type BoxPurchase = {
  buzzTransactionId: string;
  userId: number;
  unitAmount: number;
  meta: Prisma.JsonValue;
  boxDefinitionId: number;
};

export type BoxRefundOutcome =
  | { status: 'refunded'; refunded: number; clawedBack: number; payoutFailures: unknown[] }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

/** The purchase's boxes by source key: a single box's is the claim id, a pack's share its prefix. */
const ofPurchase = (column: string, purchase: BoxPurchase) => {
  const col = Prisma.raw(column);
  return boxPackTermsOf(purchase.meta)
    ? Prisma.sql`starts_with(${col}, ${packBoxSourcePrefix(purchase.buzzTransactionId)})`
    : Prisma.sql`${col} = ${purchase.buzzTransactionId}`;
};

/**
 * Flags the purchase refunded and stamps `meta.boxRefund`, then takes back what it bought: the held
 * boxes, and every opening's reward marked refunded (the reward itself is revoked in `finish`). Under
 * the holder lock, flipped only while unflipped, as the takedown's claim does, so whichever runs first
 * owns the refund; and before any ledger read, so a creator payout landing meanwhile reverses itself.
 * `taken` when another refund already owns it; `gone` when `heldBoxId` is given and no longer held.
 */
async function claim(
  tx: Tx,
  purchase: BoxPurchase,
  reason: BoxRefundReason,
  actorId: number,
  heldBoxId?: bigint
): Promise<{ meta: Prisma.JsonValue } | 'taken' | 'gone'> {
  await lockItemHolder(tx, purchase.userId);
  // Opens take the holder lock too, so a box still held here is still unopened when it's deleted.
  if (heldBoxId !== undefined) {
    const [held] = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM "Item"
      WHERE id = ${heldBoxId} AND "holderType" = 'user' AND "holderId" = ${purchase.userId}`;
    if (!held) return 'gone';
  }
  const flipped = await tx.$queryRaw<{ meta: Prisma.JsonValue }[]>`
    UPDATE "UserCosmeticShopPurchases" p
    SET refunded = true,
      meta = ${asJsonbObjectSql('p.meta')} || jsonb_build_object(
        'boxRefund', jsonb_build_object('reason', ${reason}::text, 'by', ${actorId}::int, 'at', now())
      )
    WHERE p."buzzTransactionId" = ${purchase.buzzTransactionId} AND p."userId" = ${purchase.userId}
      AND NOT p.refunded
    RETURNING p.meta`;
  if (!flipped.length) return 'taken';
  const meta = flipped[0].meta;
  const claimed = { ...purchase, meta };
  await tx.$executeRaw`
    DELETE FROM "Item"
    WHERE ${ofPurchase('"sourceKey"', claimed)} AND "itemDefinitionId" = ${purchase.boxDefinitionId}
      AND "holderType" = 'user' AND "holderId" = ${purchase.userId}`;
  await tx.$executeRaw`
    UPDATE "BoxOpening" SET "rewardStatus" = ${BOX_OPENING_REWARD_STATUS.refunded}
    WHERE ${ofPurchase('"boxSourceKey"', claimed)}
      AND "boxDefinitionId" = ${purchase.boxDefinitionId} AND "userId" = ${purchase.userId}
      AND "rewardStatus" = ${BOX_OPENING_REWARD_STATUS.granted}`;
  return { meta };
}

/**
 * Revokes the purchase's refunded rewards and returns its Buzz, reversing every payout it made (the
 * creator bears a creator box's refund). Each leg is refunded at most once by its own id, so a run
 * that dies partway is finished by running this again; `meta.boxRefund.paidAt` ends it.
 */
async function finish(purchase: BoxPurchase, reason: BoxRefundReason): Promise<BoxRefundOutcome> {
  const rewards = await dbWrite.$queryRaw<{ boxItemId: bigint; cosmeticId: number }[]>`
    SELECT o."boxItemId", d."cosmeticId"
    FROM "BoxOpening" o JOIN "ItemDefinition" d ON d.id = o."rewardDefinitionId"
    WHERE ${ofPurchase('o."boxSourceKey"', purchase)}
      AND o."boxDefinitionId" = ${purchase.boxDefinitionId} AND o."userId" = ${purchase.userId}
      AND o."rewardStatus" = ${BOX_OPENING_REWARD_STATUS.refunded}
      AND o."rewardType" = ${ITEM_TYPE.cosmetic} AND d."cosmeticId" IS NOT NULL`;
  if (rewards.length)
    await revokeCosmeticsFromUsers({
      userIds: [purchase.userId],
      cosmeticIds: rewards.map((r) => r.cosmeticId),
      claimKeys: rewards.map((r) => boxOpenClaimKey(r.boxItemId)),
    });

  const outcome =
    purchase.unitAmount === 0
      ? { status: 'refunded' as const, refunded: 0, clawedBack: 0, payoutFailures: [] }
      : partlyRefundedPack(purchase.meta)
      ? await refundRemainingPackShares(purchase, reason)
      : await reversePurchase(purchase, {
          clawback: true,
          trigger: 'reject',
          description: BOX_REFUND_DESCRIPTIONS[reason],
        });
  if (outcome.status === 'failed') return outcome;
  await dbWrite.$executeRaw`
    UPDATE "UserCosmeticShopPurchases"
    SET meta = jsonb_set(meta, '{boxRefund,paidAt}', to_jsonb(now()))
    WHERE "buzzTransactionId" = ${purchase.buzzTransactionId}`;
  if (outcome.payoutFailures.length)
    await logBoxRefund('error', 'Box refund left a payout unreversed', {
      buzzTransactionId: purchase.buzzTransactionId,
      payoutFailures: outcome.payoutFailures,
    });
  return outcome;
}

/** Boxes of this pack a takedown or the unopenable-box refund already paid back on their own. */
function partlyRefundedPack(meta: Prisma.JsonValue) {
  const byBox = meta as { packTakedownRefunds?: object; packOverPoolRefunds?: object } | null;
  return (
    !!boxPackTermsOf(meta) &&
    Object.keys({ ...byBox?.packTakedownRefunds, ...byBox?.packOverPoolRefunds }).length > 0
  );
}

/**
 * Some of the pack's boxes were paid back one by one, so the charge can't be reversed whole: every box
 * is paid its share under the box's own id instead. A share already paid answers as a duplicate, so
 * each box is paid once and the shares add up to the price. Packs are platform boxes: no payout.
 */
async function refundRemainingPackShares(
  purchase: BoxPurchase,
  reason: BoxRefundReason
): Promise<Exclude<BoxRefundOutcome, { status: 'skipped' }>> {
  const pack = boxPackTermsOf(purchase.meta);
  if (!pack) return { status: 'failed', error: 'no pack terms' };
  try {
    for (let n = 1; n <= pack.size; n++)
      await refundPackBoxShare(
        {
          boxSourceKey: packBoxSourceKey(purchase.buzzTransactionId, n),
          userId: purchase.userId,
          buzzTransactionId: purchase.buzzTransactionId,
          unitAmount: purchase.unitAmount,
          purchaseMeta: purchase.meta,
        },
        BOX_REFUND_DESCRIPTIONS[reason]
      );
  } catch (error) {
    return { status: 'failed', error: errorMessage(error) };
  }
  return { status: 'refunded', refunded: purchase.unitAmount, clawedBack: 0, payoutFailures: [] };
}

const logBoxRefund = (level: 'info' | 'error', message: string, data: Record<string, unknown>) =>
  logToAxiom({ level, name: 'mystery-box-refund', message, data }).catch(() => undefined);

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function readBoxPurchase(buzzTransactionId: string, userId: number) {
  const [row] = await dbWrite.$queryRaw<
    (BoxPurchase & { refunded: boolean; boxRefundPaid: boolean; boxRefunded: boolean })[]
  >`
    SELECT p."buzzTransactionId", p."userId", p."unitAmount", p.meta, p.refunded,
      s."itemDefinitionId" AS "boxDefinitionId",
      p.meta -> 'boxRefund' IS NOT NULL AS "boxRefunded",
      p.meta -> 'boxRefund' ->> 'paidAt' IS NOT NULL AS "boxRefundPaid"
    FROM "UserCosmeticShopPurchases" p
    JOIN "CosmeticShopItem" s ON s.id = p."shopItemId"
    WHERE p."buzzTransactionId" = ${buzzTransactionId} AND p."userId" = ${userId}
      AND s."itemDefinitionId" IS NOT NULL`;
  return row ?? null;
}

/**
 * Refunds one mystery box purchase in full: takes back its boxes and what they gave, returns the
 * buyer's Buzz and reverses the creator's payout. Running it again finishes a refund it began.
 */
export async function refundBoxPurchase({
  buzzTransactionId,
  userId,
  reason,
  actorId,
  heldBoxId,
}: {
  buzzTransactionId: string;
  userId: number;
  reason: BoxRefundReason;
  actorId: number;
  /** Refund only while this box is still held: an over-pool refund never takes an opened box. */
  heldBoxId?: bigint;
}): Promise<BoxRefundOutcome> {
  const purchase = await readBoxPurchase(buzzTransactionId, userId);
  if (!purchase) return { status: 'skipped', reason: 'not a mystery box purchase' };
  if (purchase.refunded && !purchase.boxRefunded)
    return { status: 'skipped', reason: 'already refunded' };
  if (purchase.boxRefundPaid) return { status: 'skipped', reason: 'already refunded' };

  try {
    if (!purchase.refunded) {
      // Refused before anything is taken back: a ledger this can't reverse would leave the buyer
      // with neither the box nor the Buzz.
      if (purchase.unitAmount > 0) {
        const error = partlyRefundedPack(purchase.meta)
          ? await packChargeAccountType(buzzTransactionId).then(() => undefined, errorMessage)
          : (await readPurchaseLedger(purchase)).error;
        if (error !== undefined) {
          await stampRefused(buzzTransactionId, error);
          return { status: 'failed', error };
        }
      }
      const claimed = await dbWrite.$transaction((tx) =>
        claim(tx, purchase, reason, actorId, heldBoxId)
      );
      if (claimed === 'taken') return { status: 'skipped', reason: 'already refunded' };
      if (claimed === 'gone') return { status: 'skipped', reason: 'box no longer held' };
      purchase.meta = claimed.meta;
    }
    const outcome = await finish(purchase, reason);
    if (outcome.status === 'failed') await markOwed(buzzTransactionId, outcome.error);
    return outcome;
  } catch (error) {
    await markOwed(buzzTransactionId, errorMessage(error));
    await logBoxRefund('error', 'Box refund failed', {
      buzzTransactionId,
      userId,
      reason,
      error: errorMessage(error),
    });
    return { status: 'failed', error: errorMessage(error) };
  }
}

/** Stamps a refusal before anything was taken, so a takedown batch tries it behind the rest. */
async function stampRefused(buzzTransactionId: string, error: string) {
  await dbWrite.$executeRaw`
    UPDATE "UserCosmeticShopPurchases" p
    SET meta = ${asJsonbObjectSql('p.meta')} || jsonb_build_object(
      'boxRefundRefused', jsonb_build_object('at', now(), 'error', ${error}::text)
    )
    WHERE p."buzzTransactionId" = ${buzzTransactionId}`.catch(() => undefined);
}

/** Stamps a claimed refund's failed attempt, so the job tries it again behind the ones never tried. */
async function markOwed(buzzTransactionId: string, error: string) {
  await dbWrite.$executeRaw`
    UPDATE "UserCosmeticShopPurchases"
    SET meta = jsonb_set(meta, '{boxRefund,attempt}', jsonb_build_object('at', now(), 'error', ${error}::text))
    WHERE "buzzTransactionId" = ${buzzTransactionId} AND meta -> 'boxRefund' IS NOT NULL`.catch(
    () => undefined
  );
  await logBoxRefund('error', 'Box refund owed: Buzz not returned', { buzzTransactionId, error });
}

export function listOwedBoxPurchaseRefunds(limit = 50) {
  return dbWrite.$queryRaw<
    { buzzTransactionId: string; userId: number; reason: BoxRefundReason }[]
  >`
    SELECT p."buzzTransactionId", p."userId", p.meta -> 'boxRefund' ->> 'reason' AS reason
    FROM "ItemDefinition" d
    JOIN "CosmeticShopItem" s ON s."itemDefinitionId" = d.id
    JOIN "UserCosmeticShopPurchases" p ON p."shopItemId" = s.id
    WHERE d.type = ${ITEM_TYPE.box} AND p.refunded
      AND p.meta -> 'boxRefund' IS NOT NULL AND p.meta -> 'boxRefund' ->> 'paidAt' IS NULL
    ORDER BY p.meta -> 'boxRefund' -> 'attempt' ->> 'at' NULLS FIRST, p.meta -> 'boxRefund' ->> 'at'
    LIMIT ${limit}`;
}

export type PackBoxShare = {
  /** The box's own source key: the pack charge's prefix and its number. */
  boxSourceKey: string;
  userId: number;
  buzzTransactionId: string;
  unitAmount: number;
  purchaseMeta: Prisma.JsonValue;
};

/**
 * One pack box's share of the pack charge, or null when the purchase records no usable pack terms.
 * The last box also takes the rounding remainder, so a whole pack refunded box by box returns exactly
 * its price.
 */
export function packBoxShareOf(owed: PackBoxShare) {
  let pack: ReturnType<typeof boxPackTermsOf>;
  try {
    pack = boxPackTermsOf(owed.purchaseMeta);
  } catch {
    return null;
  }
  if (!pack) return null;
  const share = Math.floor(owed.unitAmount / pack.size);
  const isLastBox = parsePackBoxSourceKey(owed.boxSourceKey)?.n === pack.size;
  return isLastBox ? owed.unitAmount - share * (pack.size - 1) : share;
}

/**
 * The one account a pack's charge came from, where its boxes' shares are paid back. Throws for a
 * charge split across accounts, which has no single place to return a share to: read before taking
 * a pack box back, so nothing is taken without a share that can be paid.
 */
export async function packChargeAccountType(buzzTransactionId: string) {
  const accountTypes = new Set(
    (await getMultiAccountTransactionsByPrefix(buzzTransactionId)).map((leg) => leg.accountType)
  );
  if (accountTypes.size !== 1)
    throw new Error(
      `Pack charge ${buzzTransactionId} has ${accountTypes.size} account types; refund it by hand`
    );
  return [...accountTypes][0];
}

/**
 * Pays one pack box its share of the pack's charge, into the account the charge came from. Its
 * external id is the box's own, so a retry after a landed attempt is refused as a duplicate (409),
 * which is read as paid, and a box is paid its share once whichever refund reaches it. It doesn't
 * start with the charge's prefix, so it is never listed as part of the charge. Returns the Buzz paid.
 */
export async function refundPackBoxShare(owed: PackBoxShare, description: string) {
  const amount = packBoxShareOf(owed);
  if (amount === null) throw new Error(`Purchase ${owed.buzzTransactionId} records no pack terms`);
  if (amount <= 0) return 0;
  const toAccountType = await packChargeAccountType(owed.buzzTransactionId);
  // A duplicate is the share already paid, never retried.
  const pay = () =>
    createBuzzTransaction({
      fromAccountId: 0,
      toAccountId: owed.userId,
      toAccountType,
      amount,
      type: TransactionType.Refund,
      description,
      externalTransactionId: `takedown-pack-share:${owed.boxSourceKey}`,
    }).catch((error) => {
      if (getBuzzApiStatus(error) !== 409) throw error;
    });
  await withRetries(pay, 3, 1000);
  return amount;
}
