import type { Prisma } from '@prisma/client';
import { boxOddsSnapshotSchema, snapshotOfLiveBox } from '@civitai/shared/box-odds-snapshot';
import {
  BOX_OPENING_REWARD_STATUS,
  ITEM_DEFINITION_STATUS,
  ITEM_TYPE,
  MOD_GRANT_SOURCE_PREFIX,
} from '@civitai/shared/mystery-box';
import { dbWrite } from '~/server/db/client';
import { lockBox } from '~/server/services/box-version-lock';
import { lockItemHolder } from '~/server/services/item-holder-lock';
import { withRetries } from '~/server/utils/errorHandling';

type Tx = Prisma.TransactionClient;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error ?? 'Unknown error');

/**
 * The new version's snapshot, read from the rows as the draw reads them. A creator box's price and
 * per-content values are carried from the version it replaces: removing a content changes neither.
 */
async function writeSnapshot(
  tx: Tx,
  {
    boxId,
    version,
    previousVersion,
    userId,
  }: { boxId: number; version: number; previousVersion: number; userId: number }
) {
  const [tiers, contents, [previous]] = await Promise.all([
    tx.$queryRaw<{ id: number; key: string; name: string; weight: number; sortOrder: number }[]>`
      SELECT id, key, name, weight, "sortOrder" FROM "BoxTier" WHERE "boxDefinitionId" = ${boxId}`,
    // Must match what the draw reads: enabled cosmetic contents.
    tx.$queryRaw<{ tierId: number; cosmeticId: number }[]>`
      SELECT bc."tierId", d."cosmeticId"
      FROM "BoxContent" bc
      JOIN "ItemDefinition" d ON d.id = bc."rewardDefinitionId"
      WHERE bc."boxDefinitionId" = ${boxId} AND bc.enabled
        AND d.type = ${ITEM_TYPE.cosmetic} AND d."cosmeticId" IS NOT NULL`,
    tx.$queryRaw<{ snapshot: unknown }[]>`
      SELECT snapshot FROM "BoxOddsSnapshot"
      WHERE "boxDefinitionId" = ${boxId} AND version = ${previousVersion}`,
  ]);
  const live = snapshotOfLiveBox(tiers, contents);
  const parsed = previous ? boxOddsSnapshotSchema.safeParse(previous.snapshot) : undefined;
  const before = parsed?.success ? parsed.data : undefined;
  const valueOf = new Map(before?.contents.map((content) => [content.cosmeticId, content.value]));
  const snapshot = {
    ...live,
    contents: live.contents.map((content) => {
      const value = valueOf.get(content.cosmeticId);
      return value === undefined ? content : { ...content, value };
    }),
    ...(before?.price !== undefined ? { price: before.price } : {}),
  };
  await tx.$executeRaw`
    INSERT INTO "BoxOddsSnapshot" ("boxDefinitionId", version, snapshot, "createdById")
    VALUES (${boxId}, ${version}, ${JSON.stringify(snapshot)}::jsonb, ${userId})`;
}

/**
 * Disables one reward in one box as a builder save would: under the box lock, a new version, and
 * that version's odds snapshot unless the box is a draft. Null when it was not enabled there.
 */
function pullFromBox({
  boxId,
  rewardDefinitionId,
  userId,
}: {
  boxId: number;
  rewardDefinitionId: number;
  userId: number;
}) {
  return dbWrite.$transaction(async (tx) => {
    const box = await lockBox(tx, boxId);
    if (!box) return null;
    const disabled = await tx.$executeRaw`
      UPDATE "BoxContent" SET enabled = false
      WHERE "boxDefinitionId" = ${boxId} AND "rewardDefinitionId" = ${rewardDefinitionId} AND enabled`;
    if (!disabled) return null;
    const [{ version }] = await tx.$queryRaw<{ version: number }[]>`
      UPDATE "ItemDefinition"
      SET version = version + 1, "updatedById" = ${userId}, "updatedAt" = now()
      WHERE id = ${boxId}
      RETURNING version`;
    if (box.status !== ITEM_DEFINITION_STATUS.draft)
      await writeSnapshot(tx, { boxId, version, previousVersion: box.version, userId });
    return version;
  });
}

/**
 * Takes a cosmetic out of every box that holds it, so no box draws it again. Per box, best-effort:
 * a box that could not be locked in time is reported in `failed` and still holds it.
 */
export async function pullCosmeticFromBoxes({
  cosmeticId,
  userId,
}: {
  cosmeticId: number;
  userId: number;
}) {
  const contents = await dbWrite.$queryRaw<{ boxId: number; rewardDefinitionId: number }[]>`
    SELECT DISTINCT bc."boxDefinitionId" AS "boxId", bc."rewardDefinitionId"
    FROM "BoxContent" bc
    JOIN "ItemDefinition" d ON d.id = bc."rewardDefinitionId"
    WHERE d."cosmeticId" = ${cosmeticId} AND d.type = ${ITEM_TYPE.cosmetic} AND bc.enabled
    ORDER BY 1`;
  const pulled: { boxId: number; version: number }[] = [];
  const failed: { boxId: number; error: string }[] = [];
  for (const { boxId, rewardDefinitionId } of contents) {
    try {
      // Retried: the lock waits only 3s on opens in flight.
      const version = await withRetries(
        () => pullFromBox({ boxId, rewardDefinitionId, userId }),
        3,
        1000
      );
      if (version !== null) pulled.push({ boxId, version });
    } catch (error) {
      failed.push({ boxId, error: errorMessage(error) });
    }
  }
  return { pulled, failed };
}

export type ClaimedBoxRefund = {
  userId: number;
  boxItemId: string;
  boxDefinitionId: number;
  boxSourceKey: string;
  /** A creator's box: its sale paid them, not only the platform. */
  sellerId: number | null;
  /**
   * The purchase this claim flagged refunded, whose Buzz the caller now owes back. Null for a box
   * no one paid for (a moderator's grant) or whose purchase was already refunded.
   */
  purchase: { buzzTransactionId: string; unitAmount: number; meta: Prisma.JsonValue } | null;
};

type GrantedOpening = {
  boxItemId: bigint;
  userId: number;
  boxDefinitionId: number;
  boxSourceKey: string;
  sellerId: number | null;
};

/**
 * Marks one opening refunded and, for a purchased box, flags its purchase refunded, under the
 * holder's lock: a moderator's refund of the same box takes that lock and flips the same two rows
 * only while they are unflipped, so whichever runs first refunds it and the other finds it done.
 * Null when it was already refunded.
 */
function claimOpening(opening: GrantedOpening): Promise<ClaimedBoxRefund | null> {
  return dbWrite.$transaction(async (tx) => {
    await lockItemHolder(tx, opening.userId);
    const flipped = await tx.$executeRaw`
      UPDATE "BoxOpening" SET "rewardStatus" = ${BOX_OPENING_REWARD_STATUS.refunded}
      WHERE "boxItemId" = ${opening.boxItemId}
        AND "rewardStatus" = ${BOX_OPENING_REWARD_STATUS.granted}`;
    if (!flipped) return null;
    const claim = {
      userId: opening.userId,
      boxItemId: opening.boxItemId.toString(),
      boxDefinitionId: opening.boxDefinitionId,
      boxSourceKey: opening.boxSourceKey,
      sellerId: opening.sellerId,
    };
    if (opening.boxSourceKey.startsWith(MOD_GRANT_SOURCE_PREFIX))
      return { ...claim, purchase: null };
    // Through the listing's box, as the moderator refund finds it: the source key alone is a string
    // anything could have written.
    const [purchase] = await tx.$queryRaw<NonNullable<ClaimedBoxRefund['purchase']>[]>`
      UPDATE "UserCosmeticShopPurchases" p SET refunded = true
      FROM "CosmeticShopItem" s
      WHERE p."buzzTransactionId" = ${opening.boxSourceKey} AND p."userId" = ${opening.userId}
        AND NOT p.refunded
        AND s.id = p."shopItemId" AND s."itemDefinitionId" = ${opening.boxDefinitionId}
      RETURNING p."buzzTransactionId", p."unitAmount", p.meta`;
    return { ...claim, purchase: purchase ?? null };
  });
}

/**
 * Every opening that drew this cosmetic and still holds it, claimed for a refund one by one. Read
 * after `pullCosmeticFromBoxes`, so no open drawing it can commit after this read. Best-effort per
 * opening: one whose holder's lock was busy is reported in `failed` and left granted.
 */
export async function claimBoxRefundsForCosmetic({ cosmeticId }: { cosmeticId: number }) {
  const openings = await dbWrite.$queryRaw<GrantedOpening[]>`
    SELECT o."boxItemId", o."userId", o."boxDefinitionId", o."boxSourceKey", b."sellerId"
    FROM "BoxOpening" o
    JOIN "ItemDefinition" d ON d.id = o."rewardDefinitionId"
    JOIN "ItemDefinition" b ON b.id = o."boxDefinitionId"
    WHERE d."cosmeticId" = ${cosmeticId} AND d.type = ${ITEM_TYPE.cosmetic}
      AND o."rewardType" = ${ITEM_TYPE.cosmetic}
      AND o."rewardStatus" = ${BOX_OPENING_REWARD_STATUS.granted}
    ORDER BY o."boxItemId"`;
  const claimed: ClaimedBoxRefund[] = [];
  const failed: { userId: number; boxItemId: string; error: string }[] = [];
  for (const opening of openings) {
    try {
      const claim = await withRetries(() => claimOpening(opening), 3, 1000);
      if (claim) claimed.push(claim);
    } catch (error) {
      failed.push({
        userId: opening.userId,
        boxItemId: opening.boxItemId.toString(),
        error: errorMessage(error),
      });
    }
  }
  return { claimed, failed };
}
