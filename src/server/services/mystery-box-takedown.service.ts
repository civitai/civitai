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
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';

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

type GrantedOpening = {
  boxItemId: bigint;
  userId: number;
  boxDefinitionId: number;
  boxSourceKey: string;
};

/**
 * Marks one opening refunded and, for a purchased box, flags its purchase refunded and stamps it
 * `meta.takedownRefund`: the Buzz is owed from here until `markBoxRefundPaid`. Under the holder's
 * lock, and each flip only while unflipped, as the moderator app's box refund does, so whichever of
 * the two runs first takes the refund and the other finds it done.
 */
function claimOpening(opening: GrantedOpening, shopItemId: number) {
  return dbWrite.$transaction(async (tx) => {
    await lockItemHolder(tx, opening.userId);
    const flipped = await tx.$executeRaw`
      UPDATE "BoxOpening" SET "rewardStatus" = ${BOX_OPENING_REWARD_STATUS.refunded}
      WHERE "boxItemId" = ${opening.boxItemId}
        AND "rewardStatus" = ${BOX_OPENING_REWARD_STATUS.granted}`;
    if (!flipped || opening.boxSourceKey.startsWith(MOD_GRANT_SOURCE_PREFIX)) return;
    // Through the listing's box, as the moderator refund finds it: the source key alone is a string
    // anything could have written.
    await tx.$executeRaw`
      UPDATE "UserCosmeticShopPurchases" p
      SET refunded = true,
        meta = ${asJsonbObjectSql('p.meta')} || jsonb_build_object(
          'takedownRefund', jsonb_build_object('shopItemId', ${shopItemId}::int, 'at', now())
        )
      FROM "CosmeticShopItem" s
      WHERE p."buzzTransactionId" = ${opening.boxSourceKey} AND p."userId" = ${opening.userId}
        AND NOT p.refunded
        AND s.id = p."shopItemId" AND s."itemDefinitionId" = ${opening.boxDefinitionId}`;
  });
}

/**
 * Every opening that drew this cosmetic and still holds it, claimed for a refund one by one. Read
 * after `pullCosmeticFromBoxes`, so no open drawing it can commit after this read. Best-effort per
 * opening: one whose holder's lock was busy is reported in `failed` and left granted.
 */
export async function claimBoxRefundsForCosmetic({
  cosmeticId,
  shopItemId,
}: {
  cosmeticId: number;
  /** The listing being taken down, stamped on each claimed purchase. */
  shopItemId: number;
}) {
  const openings = await dbWrite.$queryRaw<GrantedOpening[]>`
    SELECT o."boxItemId", o."userId", o."boxDefinitionId", o."boxSourceKey"
    FROM "BoxOpening" o
    JOIN "ItemDefinition" d ON d.id = o."rewardDefinitionId"
    WHERE d."cosmeticId" = ${cosmeticId} AND d.type = ${ITEM_TYPE.cosmetic}
      AND o."rewardType" = ${ITEM_TYPE.cosmetic}
      AND o."rewardStatus" = ${BOX_OPENING_REWARD_STATUS.granted}
    ORDER BY o."boxItemId"`;
  const failed: { userId: number; boxItemId: string; error: string }[] = [];
  for (const opening of openings) {
    try {
      // A retry after an attempt that committed finds nothing left to flip; its purchase is still
      // stamped, so `listOwedBoxRefunds` pays it.
      await withRetries(() => claimOpening(opening, shopItemId), 3, 1000);
    } catch (error) {
      failed.push({
        userId: opening.userId,
        boxItemId: opening.boxItemId.toString(),
        error: errorMessage(error),
      });
    }
  }
  return { openings: openings.length, failed };
}

export type OwedBoxRefund = {
  buzzTransactionId: string;
  userId: number;
  unitAmount: number;
  meta: Prisma.JsonValue;
  boxDefinitionId: number;
  /** A creator's box: its sale paid them, not only the platform. */
  sellerId: number | null;
};

/**
 * Box purchases this takedown flagged refunded and has not paid back yet, including any an earlier
 * run of it claimed and died before paying. Read from the stamp, not from this run's claims, so
 * running the takedown again finishes them; found through the refunded openings, which are never
 * deleted, where a box's content row can be.
 */
export function listOwedBoxRefunds({
  cosmeticId,
  shopItemId,
}: {
  cosmeticId: number;
  shopItemId: number;
}) {
  return dbWrite.$queryRaw<OwedBoxRefund[]>`
    SELECT p."buzzTransactionId", p."userId", p."unitAmount", p.meta,
      o."boxDefinitionId", b."sellerId"
    FROM "BoxOpening" o
    JOIN "ItemDefinition" d ON d.id = o."rewardDefinitionId"
    JOIN "ItemDefinition" b ON b.id = o."boxDefinitionId"
    JOIN "UserCosmeticShopPurchases" p
      ON p."buzzTransactionId" = o."boxSourceKey" AND p."userId" = o."userId"
    JOIN "CosmeticShopItem" s ON s.id = p."shopItemId" AND s."itemDefinitionId" = o."boxDefinitionId"
    WHERE d."cosmeticId" = ${cosmeticId} AND d.type = ${ITEM_TYPE.cosmetic}
      AND o."rewardStatus" = ${BOX_OPENING_REWARD_STATUS.refunded}
      AND p.refunded
      AND (p.meta->'takedownRefund'->>'shopItemId')::int = ${shopItemId}
      AND p.meta->'takedownRefund'->>'paidAt' IS NULL
    ORDER BY p."buzzTransactionId"`;
}

/** Ends what `claimOpening` owed: the Buzz for this purchase is back with its buyer. */
export function markBoxRefundPaid(buzzTransactionId: string) {
  return dbWrite.$executeRaw`
    UPDATE "UserCosmeticShopPurchases"
    SET meta = jsonb_set(meta, '{takedownRefund,paidAt}', to_jsonb(now()))
    WHERE "buzzTransactionId" = ${buzzTransactionId}`;
}
