import { Prisma } from '@prisma/client';
import { boxOddsSnapshotSchema, snapshotOfLiveBox } from '@civitai/shared/box-odds-snapshot';
import {
  BOX_OPENING_REWARD_STATUS,
  ITEM_DEFINITION_STATUS,
  boxOpenClaimKey,
  ITEM_TYPE,
  MOD_GRANT_SOURCE_PREFIX,
  parsePackBoxSourceKey,
} from '@civitai/shared/mystery-box';
import { NotificationCategory } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import { revokeCosmeticsFromUsers } from '~/server/services/cosmetic.service';
import { appendItemHistory } from '~/server/services/creator-shop.data';
import { refundBoxPurchase } from '~/server/services/mystery-box-refund.service';
import { createNotification } from '~/server/services/notification.service';
import { lockBox } from '~/server/services/box-version-lock';
import { lockItemHolder } from '~/server/services/item-holder-lock';
import { throwNotFoundError, withRetries } from '~/server/utils/errorHandling';
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
    if (!flipped) return 'none';
    if (opening.boxSourceKey.startsWith(MOD_GRANT_SOURCE_PREFIX)) return 'granted';
    // One box of a pack is owed its share, not the pack's charge: stamped per box, the purchase stays
    // unrefunded for the rest of the pack.
    const packBox = parsePackBoxSourceKey(opening.boxSourceKey);
    if (packBox) {
      const boxKey = opening.boxItemId.toString();
      await tx.$executeRaw`
        UPDATE "UserCosmeticShopPurchases" p
        SET meta = ${asJsonbObjectSql('p.meta')} || jsonb_build_object(
          'packTakedownRefunds',
          COALESCE(${asJsonbObjectSql('p.meta')} -> 'packTakedownRefunds', '{}'::jsonb)
            || jsonb_build_object(${boxKey}::text, jsonb_build_object('shopItemId', ${shopItemId}::int, 'at', now()))
        )
        FROM "CosmeticShopItem" s
        WHERE p."buzzTransactionId" = ${packBox.transactionId} AND p."userId" = ${opening.userId}
          AND NOT p.refunded
          AND s.id = p."shopItemId" AND s."itemDefinitionId" = ${opening.boxDefinitionId}`;
      return 'purchased';
    }
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
    return 'purchased';
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
  // Openers of a moderator's grant lose what they drew too, with no Buzz to return.
  const grantedUserIds = new Set<number>();
  for (const opening of openings) {
    try {
      // A retry after an attempt that committed finds nothing left to flip; its purchase is still
      // stamped, so `listOwedBoxRefunds` pays it.
      const claimed = await withRetries(() => claimOpening(opening, shopItemId), 3, 1000);
      if (claimed === 'granted') grantedUserIds.add(opening.userId);
    } catch (error) {
      failed.push({
        userId: opening.userId,
        boxItemId: opening.boxItemId.toString(),
        error: errorMessage(error),
      });
    }
  }
  return { openings: openings.length, failed, grantedUserIds: [...grantedUserIds] };
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

export type OwedPackBoxRefund = {
  boxItemId: bigint;
  boxSourceKey: string;
  userId: number;
  /** The pack purchase's charge prefix. */
  buzzTransactionId: string;
  unitAmount: number;
  /** The purchase's meta, which holds the pack terms it was sold under. */
  purchaseMeta: Prisma.JsonValue;
};

/**
 * Pack boxes this takedown claimed and has not paid back yet, as `listOwedBoxRefunds` finds whole
 * purchases: from the per-box stamp, so running the takedown again finishes them.
 */
export function listOwedPackBoxRefunds({
  cosmeticId,
  shopItemId,
}: {
  cosmeticId: number;
  shopItemId: number;
}) {
  return dbWrite.$queryRaw<OwedPackBoxRefund[]>`
    SELECT o."boxItemId", o."boxSourceKey", o."userId", p."buzzTransactionId", p."unitAmount",
      p.meta AS "purchaseMeta"
    FROM "BoxOpening" o
    JOIN "ItemDefinition" d ON d.id = o."rewardDefinitionId"
    JOIN "UserCosmeticShopPurchases" p
      ON p."buzzTransactionId" = substring(o."boxSourceKey" from '^(.*)#pack-[0-9]{2}$')
      AND p."userId" = o."userId"
    JOIN "CosmeticShopItem" s ON s.id = p."shopItemId" AND s."itemDefinitionId" = o."boxDefinitionId"
    WHERE d."cosmeticId" = ${cosmeticId} AND d.type = ${ITEM_TYPE.cosmetic}
      AND o."rewardStatus" = ${BOX_OPENING_REWARD_STATUS.refunded}
      AND (p.meta -> 'packTakedownRefunds' -> (o."boxItemId"::text) ->> 'shopItemId')::int = ${shopItemId}
      AND p.meta -> 'packTakedownRefunds' -> (o."boxItemId"::text) ->> 'paidAt' IS NULL
    ORDER BY o."boxItemId"`;
}

/** Ends what `claimOpening` owed one pack box. */
export function markPackBoxRefundPaid(buzzTransactionId: string, boxItemId: bigint) {
  return dbWrite.$executeRaw`
    UPDATE "UserCosmeticShopPurchases"
    SET meta = jsonb_set(
      meta, ARRAY['packTakedownRefunds', ${boxItemId.toString()}::text, 'paidAt'], to_jsonb(now())
    )
    WHERE "buzzTransactionId" = ${buzzTransactionId}`;
}

/** Ends what `claimOpening` owed: the Buzz for this purchase is back with its buyer. */
export function markBoxRefundPaid(buzzTransactionId: string) {
  return dbWrite.$executeRaw`
    UPDATE "UserCosmeticShopPurchases"
    SET meta = jsonb_set(meta, '{takedownRefund,paidAt}', to_jsonb(now()))
    WHERE "buzzTransactionId" = ${buzzTransactionId}`;
}

/**
 * Takes a whole mystery box down: stops its sales, then refunds every purchase of it, opened and
 * unopened, taking back the boxes and what they gave and reversing the creator's payouts. Boxes a
 * moderator granted are taken back with what they gave, with no money to return. A creator's
 * submission fee is kept, as for an item takedown. Refunds the first `limit` purchases here; the
 * hourly over-pool job refunds the rest (`continueBoxTakedowns`), and running this again does too.
 */
export async function takedownMysteryBox({
  id,
  reason,
  moderatorId,
  limit = 20,
}: {
  /** The box's listing, as the review queue names it. */
  id: number;
  reason: string;
  moderatorId: number;
  limit?: number;
}) {
  const [listing] = await dbWrite.$queryRaw<{ boxId: number | null; title: string }[]>`
    SELECT "itemDefinitionId" AS "boxId", title FROM "CosmeticShopItem" WHERE id = ${id}`;
  if (!listing?.boxId) throw throwNotFoundError('Mystery box listing not found');
  const boxId = listing.boxId;
  const now = new Date().toISOString();

  // Sales stop before any refund, so no purchase can land after the list is read.
  const box = await dbWrite.$transaction(async (tx) => {
    const locked = await lockBox(tx, boxId);
    const [row] = await tx.$queryRaw<{ type: string; sellerId: number | null }[]>`
      SELECT type, "sellerId" FROM "ItemDefinition" WHERE id = ${boxId}`;
    if (!locked || row?.type !== ITEM_TYPE.box) return null;
    await tx.$executeRaw`
      UPDATE "ItemDefinition"
      SET status = ${ITEM_DEFINITION_STATUS.archived}, "updatedById" = ${moderatorId}, "updatedAt" = now()
      WHERE id = ${boxId}`;
    const listings = await tx.$queryRaw<{ id: number; meta: CosmeticShopItemMeta | null }[]>`
      SELECT id, meta FROM "CosmeticShopItem" WHERE "itemDefinitionId" = ${boxId} FOR UPDATE`;
    let retried = false;
    for (const item of listings) {
      const meta = (item.meta ?? {}) as CosmeticShopItemMeta;
      retried ||= !!meta.takedown;
      const next = appendItemHistory(
        { ...meta, takedown: meta.takedown ?? { reason, moderatorId, at: now } },
        {
          at: now,
          userId: moderatorId,
          kind: 'takedown',
          status: 'Archived',
          note: meta.takedown ? `Retried: ${reason}` : reason,
        }
      );
      // Event tags place a listing in tagged sections, as the placement rows do by hand.
      await tx.$executeRaw`
        UPDATE "CosmeticShopItem"
        SET status = 'Archived', listed = false, "eventTags" = '{}',
          "archivedAt" = COALESCE("archivedAt", now()), meta = ${JSON.stringify(next)}::jsonb
        WHERE id = ${item.id}`;
    }
    await tx.$executeRaw`
      DELETE FROM "CosmeticShopSectionItem"
      WHERE "shopItemId" IN (SELECT id FROM "CosmeticShopItem" WHERE "itemDefinitionId" = ${boxId})`;
    return { ...row, retried };
  });
  if (!box) throw throwNotFoundError('Mystery box not found');

  if (box.sellerId && !box.retried)
    await createNotification({
      type: 'creator-shop-item-taken-down',
      userId: box.sellerId,
      category: NotificationCategory.System,
      key: `creator-shop-item-taken-down:${id}`,
      details: { title: listing.title, reason },
    });

  const result = await refundTakenDownBox({
    boxId,
    title: listing.title,
    limit,
    actorId: moderatorId,
  });
  await logToAxiom({
    level: result.failed.length ? 'error' : 'info',
    name: 'mystery-box-takedown',
    message: 'Box takedown run finished',
    data: { ...result, moderatorId, reason },
  }).catch(() => undefined);
  return result;
}

/**
 * Up to `limit` of a taken-down box's purchases refunded, unrefunded ones and any claimed and never
 * paid back, with each buyer told; then, once none are left, its granted boxes taken back.
 */
async function refundTakenDownBox({
  boxId,
  title,
  limit,
  actorId,
}: {
  boxId: number;
  title: string;
  limit: number;
  actorId: number;
}) {
  const owedWhere = Prisma.sql`
    s."itemDefinitionId" = ${boxId}
    AND (NOT p.refunded
      OR (p.meta -> 'boxRefund' IS NOT NULL AND p.meta -> 'boxRefund' ->> 'paidAt' IS NULL))`;
  const purchases = await dbWrite.$queryRaw<{ buzzTransactionId: string; userId: number }[]>`
    SELECT p."buzzTransactionId", p."userId"
    FROM "CosmeticShopItem" s
    JOIN "UserCosmeticShopPurchases" p ON p."shopItemId" = s.id
    WHERE ${owedWhere}
    -- A purchase that failed before goes behind the rest, so failures never fill the batch.
    ORDER BY COALESCE(p.meta -> 'boxRefund' -> 'attempt' ->> 'at', p.meta -> 'boxRefundRefused' ->> 'at')
      NULLS FIRST, p."purchasedAt"
    LIMIT ${limit}`;
  const failed: { userId: number; buzzTransactionId: string; error: string }[] = [];
  let refunded = 0;
  let refundedValue = 0;
  let clawedBack = 0;
  for (const purchase of purchases) {
    const outcome = await refundBoxPurchase({ ...purchase, reason: 'box-takedown', actorId });
    if (outcome.status === 'failed') failed.push({ ...purchase, error: outcome.error });
    if (outcome.status !== 'refunded') continue;
    refunded++;
    refundedValue += outcome.refunded;
    clawedBack += outcome.clawedBack;
    for (const failure of outcome.payoutFailures)
      failed.push({ ...purchase, error: `Payout not reversed: ${JSON.stringify(failure)}` });
    await createNotification({
      type: 'cosmetic-shop-item-taken-down',
      userId: purchase.userId,
      category: NotificationCategory.System,
      key: `cosmetic-shop-item-taken-down:box-${boxId}:${purchase.buzzTransactionId}`,
      details: { title },
    });
  }

  // Granted boxes once the purchases are through, not on every batch: their read spans the box. A
  // full batch can be the last one, and nothing selects this box again once none are owed.
  const more =
    purchases.length === limit &&
    (
      await dbWrite.$queryRaw<{ owed: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM "CosmeticShopItem" s
          JOIN "UserCosmeticShopPurchases" p ON p."shopItemId" = s.id
          WHERE ${owedWhere}
        ) AS owed`
    )[0].owed;
  const grantsTakenBack = more ? 0 : await takeBackGrantsAndTell(boxId, title);

  return {
    boxId,
    purchases: purchases.length,
    refunded,
    refundedValue,
    clawedBack,
    grantsTakenBack,
    failed,
    more,
  };
}

/** `takeBackGrantedBoxes`, with each holder whose boxes went told. */
async function takeBackGrantsAndTell(boxId: number, title: string) {
  const granted = await takeBackGrantedBoxes(boxId);
  for (const userId of granted.userIds)
    await createNotification({
      type: 'cosmetic-shop-item-removed',
      userId,
      category: NotificationCategory.System,
      key: `cosmetic-shop-item-removed:box-${boxId}:${userId}`,
      details: { title },
    });
  return granted.boxes;
}

/**
 * Refunds what box takedowns left, and takes back what they left granted, box by box until the
 * deadline. A box with nothing owed but grants still out (a run died after its last refund) is
 * picked up too.
 */
export async function continueBoxTakedowns(deadline: number) {
  const boxes = await dbWrite.$queryRaw<{ boxId: number; title: string }[]>`
    SELECT DISTINCT ON (s."itemDefinitionId") s."itemDefinitionId" AS "boxId", s.title
    FROM "CosmeticShopItem" s
    WHERE s."itemDefinitionId" IS NOT NULL AND s.meta ? 'takedown'
      AND (
        EXISTS (
          SELECT 1 FROM "UserCosmeticShopPurchases" p
          WHERE p."shopItemId" = s.id
            AND (NOT p.refunded
              OR (p.meta -> 'boxRefund' IS NOT NULL AND p.meta -> 'boxRefund' ->> 'paidAt' IS NULL))
        )
        OR EXISTS (
          SELECT 1 FROM "Item" i
          WHERE i."itemDefinitionId" = s."itemDefinitionId" AND i."holderType" = 'user'
            AND starts_with(i."sourceKey", ${MOD_GRANT_SOURCE_PREFIX})
        )
        OR EXISTS (
          SELECT 1 FROM "BoxOpening" o
          WHERE o."boxDefinitionId" = s."itemDefinitionId"
            AND o."rewardStatus" = ${BOX_OPENING_REWARD_STATUS.granted}
            AND starts_with(o."boxSourceKey", ${MOD_GRANT_SOURCE_PREFIX})
        )
      )
    ORDER BY s."itemDefinitionId"`;
  let refunded = 0;
  const failed: { boxId: number; error: string }[] = [];
  for (const { boxId, title } of boxes) {
    try {
      // A batch whose purchases all fail ends this box's turn; the next run tries them again.
      let more = false;
      while (Date.now() < deadline) {
        const batch = await refundTakenDownBox({ boxId, title, limit: 50, actorId: -1 });
        refunded += batch.refunded;
        more = batch.more;
        if (!batch.more || !batch.refunded) break;
      }
      // Purchases still owed (failing, or past the deadline) don't keep the free grants out: they
      // cost nothing, and an archived box still opens.
      if (more) await takeBackGrantsAndTell(boxId, title);
    } catch (error) {
      failed.push({ boxId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (failed.length)
    await logToAxiom({
      level: 'error',
      name: 'mystery-box-takedown',
      message: 'Box takedowns left work behind',
      data: { failed },
    }).catch(() => undefined);
  return { boxes: boxes.length, refunded, failed };
}

/**
 * Every box a moderator granted from this box, held or opened: the held ones deleted, the opened
 * ones' rewards revoked and their openings marked refunded. Nothing was paid, so nothing is returned.
 */
async function takeBackGrantedBoxes(boxId: number) {
  const holders = await dbWrite.$queryRaw<{ userId: number }[]>`
    SELECT DISTINCT "holderId" AS "userId" FROM "Item"
    WHERE "itemDefinitionId" = ${boxId} AND "holderType" = 'user'
      AND starts_with("sourceKey", ${MOD_GRANT_SOURCE_PREFIX})
    UNION
    SELECT DISTINCT "userId" FROM "BoxOpening"
    WHERE "boxDefinitionId" = ${boxId} AND starts_with("boxSourceKey", ${MOD_GRANT_SOURCE_PREFIX})`;
  let boxes = 0;
  const userIds: number[] = [];
  for (const { userId } of holders) {
    const changed = await dbWrite.$transaction(async (tx) => {
      await lockItemHolder(tx, userId);
      const deleted = await tx.$executeRaw`
        DELETE FROM "Item"
        WHERE "itemDefinitionId" = ${boxId} AND "holderType" = 'user' AND "holderId" = ${userId}
          AND starts_with("sourceKey", ${MOD_GRANT_SOURCE_PREFIX})`;
      const flipped = await tx.$executeRaw`
        UPDATE "BoxOpening" SET "rewardStatus" = ${BOX_OPENING_REWARD_STATUS.refunded}
        WHERE "boxDefinitionId" = ${boxId} AND "userId" = ${userId}
          AND "rewardStatus" = ${BOX_OPENING_REWARD_STATUS.granted}
          AND starts_with("boxSourceKey", ${MOD_GRANT_SOURCE_PREFIX})`;
      return deleted + flipped;
    });
    boxes += changed;
    // Every refunded granted opening, not only this run's: a revoke a run died before is redone.
    const cosmetics = await dbWrite.$queryRaw<{ boxItemId: bigint; cosmeticId: number }[]>`
      SELECT o."boxItemId", d."cosmeticId"
      FROM "BoxOpening" o JOIN "ItemDefinition" d ON d.id = o."rewardDefinitionId"
      WHERE o."boxDefinitionId" = ${boxId} AND o."userId" = ${userId}
        AND o."rewardStatus" = ${BOX_OPENING_REWARD_STATUS.refunded}
        AND starts_with(o."boxSourceKey", ${MOD_GRANT_SOURCE_PREFIX})
        AND d."cosmeticId" IS NOT NULL`;
    if (cosmetics.length)
      await revokeCosmeticsFromUsers({
        userIds: [userId],
        cosmeticIds: cosmetics.map((r) => r.cosmeticId),
        claimKeys: cosmetics.map((r) => boxOpenClaimKey(r.boxItemId)),
      });
    if (changed) userIds.push(userId);
  }
  return { boxes, userIds };
}
