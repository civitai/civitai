import {
  ITEM_DEFINITION_STATUS,
  ITEM_TYPE,
  MOD_GRANT_SOURCE_PREFIX,
  parsePackBoxSourceKey,
} from '@civitai/shared/mystery-box';
import { dbRead, dbWrite } from '~/server/db/client';
import { getEventBuyerTeam, isEventShopItemData } from '~/server/events/event-shop-item';
import { logToAxiom } from '~/server/logging/client';
import { createNotification } from '~/server/services/notification.service';
import { lockItemHolder } from '~/server/services/item-holder-lock';
import type { BoxCatalogEntry } from '~/server/services/mystery-box.service';
import { getBoxCatalog, getBoxPoolForUser } from '~/server/services/mystery-box.service';
import { continueBoxTakedowns } from '~/server/services/mystery-box-takedown.service';
import {
  BOX_REFUND_DESCRIPTIONS,
  listOwedBoxPurchaseRefunds,
  refundBoxPurchase,
  refundPackBoxShare,
} from '~/server/services/mystery-box-refund.service';
import { NotificationCategory } from '~/server/common/enums';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const log = (level: 'info' | 'error', message: string, data: Record<string, unknown>) =>
  logToAxiom({ level, name: 'mystery-box-over-pool', message, data }).catch(() => undefined);

type Holding = { boxDefinitionId: number; userId: number; held: number; params: unknown };

/**
 * Unlocked, on the replica, so a holder with nothing over the pool costs no lock and no write
 * connection. A lagging replica only defers an excess to the scan's next pass; the locked read decides, and
 * never takes the replica's catalog. An unreadable replica falls through to the locked read.
 */
async function withinPoolOnReplica(
  { boxDefinitionId, userId, held }: Holding,
  team: string | undefined,
  catalogs: Map<number, BoxCatalogEntry[]>
) {
  try {
    let catalog = catalogs.get(boxDefinitionId);
    if (!catalog) {
      catalog = await getBoxCatalog(dbRead, boxDefinitionId);
      catalogs.set(boxDefinitionId, catalog);
    }
    const pool = await getBoxPoolForUser(dbRead, { boxDefinitionId, userId, team, catalog });
    return held <= pool.length;
  } catch {
    return false;
  }
}

async function overPoolBoxes(holding: Holding, catalogs: Map<number, BoxCatalogEntry[]>) {
  const { boxDefinitionId, userId, params } = holding;
  // Read before the transaction: the team lookup isn't on its connection.
  const team = isEventShopItemData(params)
    ? await getEventBuyerTeam(params.event, userId)
    : undefined;
  if (await withinPoolOnReplica(holding, team, catalogs)) return [];
  return dbWrite.$transaction(async (tx) => {
    await lockItemHolder(tx, userId);
    const pool = await getBoxPoolForUser(tx, { boxDefinitionId, userId, team });
    const held = await tx.$queryRaw<{ id: bigint; sourceKey: string }[]>`
      SELECT id, "sourceKey" FROM "Item"
      WHERE "holderType" = 'user' AND "holderId" = ${userId}
        AND "itemDefinitionId" = ${boxDefinitionId}
      ORDER BY id DESC`;
    const excess = held.length - pool.length;
    // A granted box cost nothing, so it isn't refunded: it stays held, and opens if contents arrive.
    return excess > 0
      ? held.filter((item) => !item.sourceKey.startsWith(MOD_GRANT_SOURCE_PREFIX)).slice(0, excess)
      : [];
  });
}

/**
 * Takes one held pack box back and stamps the purchase `meta.packOverPoolRefunds[<boxItemId>]`, so
 * the share is owed from here until it is paid. Null when the box is gone (opened, or refunded).
 */
async function claimPackBox(item: { id: bigint; sourceKey: string }, userId: number) {
  const packBox = parsePackBoxSourceKey(item.sourceKey);
  if (!packBox) return null;
  return dbWrite.$transaction(async (tx) => {
    await lockItemHolder(tx, userId);
    const deleted = await tx.$executeRaw`
      DELETE FROM "Item" WHERE id = ${item.id} AND "holderType" = 'user' AND "holderId" = ${userId}`;
    if (!deleted) return null;
    const [purchase] = await tx.$queryRaw<
      { buzzTransactionId: string; unitAmount: number; meta: unknown }[]
    >`
      UPDATE "UserCosmeticShopPurchases" p
      SET meta = ${asJsonbObjectSql('p.meta')} || jsonb_build_object(
        'packOverPoolRefunds',
        COALESCE(${asJsonbObjectSql('p.meta')} -> 'packOverPoolRefunds', '{}'::jsonb)
          || jsonb_build_object(
            ${item.id.toString()}::text,
            jsonb_build_object('at', now(), 'sourceKey', ${item.sourceKey}::text)
          )
      )
      WHERE p."buzzTransactionId" = ${packBox.transactionId} AND p."userId" = ${userId}
        AND NOT p.refunded
      RETURNING p."buzzTransactionId", p."unitAmount", p.meta`;
    // No unrefunded purchase: the box is gone with nothing owed. Thrown to put it back.
    if (!purchase) throw new Error(`Pack box ${item.id} has no unrefunded purchase`);
    return purchase;
  });
}

async function markPackBoxPaid(buzzTransactionId: string, boxItemId: bigint) {
  await dbWrite.$executeRaw`
    UPDATE "UserCosmeticShopPurchases"
    SET meta = jsonb_set(
      meta, ARRAY['packOverPoolRefunds', ${boxItemId.toString()}::text, 'paidAt'], to_jsonb(now())
    )
    WHERE "buzzTransactionId" = ${buzzTransactionId}`;
}

/**
 * Pack box shares this job claimed and never paid, from the stamp, so a run that died after taking
 * the box back is finished by the next one.
 */
async function payOwedPackShares(failed: { userId: number; error: string }[]) {
  const owed = await dbWrite.$queryRaw<
    {
      boxItemId: string;
      boxSourceKey: string;
      userId: number;
      buzzTransactionId: string;
      unitAmount: number;
      purchaseMeta: unknown;
    }[]
  >`
    SELECT r.key AS "boxItemId", r.value ->> 'sourceKey' AS "boxSourceKey", p."userId", p."buzzTransactionId", p."unitAmount",
      p.meta AS "purchaseMeta"
    FROM "ItemDefinition" d
    JOIN "CosmeticShopItem" s ON s."itemDefinitionId" = d.id
    JOIN "UserCosmeticShopPurchases" p ON p."shopItemId" = s.id
    CROSS JOIN LATERAL jsonb_each(p.meta -> 'packOverPoolRefunds') r
    WHERE d.type = ${ITEM_TYPE.box} AND p.meta ? 'packOverPoolRefunds'
      AND r.value ->> 'paidAt' IS NULL`;
  let paid = 0;
  for (const share of owed) {
    const boxItemId = BigInt(share.boxItemId);
    try {
      await refundPackBoxShare(
        { ...share, purchaseMeta: share.purchaseMeta as never },
        BOX_REFUND_DESCRIPTIONS['over-pool']
      );
      await markPackBoxPaid(share.buzzTransactionId, boxItemId);
      paid++;
      await notifyUnopenable(share.userId, share.boxSourceKey);
    } catch (error) {
      failed.push({
        userId: share.userId,
        error: `Pack box ${share.boxItemId}: ${errorMessage(error)}`,
      });
    }
  }
  return paid;
}

const PAGE = 200;
/** Within the job's 30 minute lock, with room to finish the page in hand. */
const DEFAULT_BUDGET_MS = 20 * 60 * 1000;

type ScanCursor = { boxDefinitionId: number; userId: number };
const SCAN_START: ScanCursor = { boxDefinitionId: 0, userId: 0 };
const SCAN_CURSOR_KEY = 'mystery-box-over-pool-scan-cursor';

/** Where the last run stopped, so a scan longer than one run's budget still reaches the tail. */
async function readScanCursor(): Promise<ScanCursor> {
  const [row] = await dbWrite.$queryRaw<{ value: Partial<ScanCursor> | null }[]>`
    SELECT value FROM "KeyValue" WHERE key = ${SCAN_CURSOR_KEY}`;
  const v = row?.value;
  return v && Number.isSafeInteger(v.boxDefinitionId) && Number.isSafeInteger(v.userId)
    ? { boxDefinitionId: v.boxDefinitionId as number, userId: v.userId as number }
    : SCAN_START;
}

async function writeScanCursor(cursor: ScanCursor) {
  const value = JSON.stringify({
    boxDefinitionId: cursor.boxDefinitionId,
    userId: cursor.userId,
  });
  await dbWrite.$executeRaw`
    INSERT INTO "KeyValue" (key, value) VALUES (${SCAN_CURSOR_KEY}, ${value}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
}

const notifyUnopenable = (userId: number, key: string) =>
  createNotification({
    type: 'mystery-box-refunded-unopenable',
    userId,
    category: NotificationCategory.System,
    key: `mystery-box-refunded-unopenable:${key}`,
    details: {},
  }).catch(() => undefined);

/**
 * Refunds held boxes that can never open: after contents leave a box (a takedown, a creator's
 * revision, a moderator's edit), a holder can hold more boxes than there is left for them. The
 * excess, newest first, is refunded: a single box's whole purchase, a pack box its share. Then
 * finishes box refunds that were claimed and not paid back, and continues box takedowns. Pages
 * through the holdings from where the last run stopped until the time budget runs out.
 */
export async function refundOverPoolBoxes({
  pageSize = PAGE,
  budgetMs = DEFAULT_BUDGET_MS,
}: { pageSize?: number; budgetMs?: number } = {}) {
  const deadline = Date.now() + budgetMs;
  const failed: { userId: number; error: string }[] = [];
  // Money already owed first: those buyers' boxes are gone. The scan gets what time is left.
  const sharesPaid = await payOwedPackShares(failed);
  const finished = await finishOwedRefunds(failed, deadline);
  const takedowns = await continueBoxTakedowns(deadline);
  let holdingsChecked = 0;
  let refunded = 0;
  let after = await readScanCursor();
  let done = false;
  // A catalog read late in the run only defers an excess or sends it to the locked read.
  const catalogs = new Map<number, BoxCatalogEntry[]>();
  while (!done && Date.now() < deadline) {
    // Holder first: the keyset is then a range on the (holderType, holderId, itemDefinitionId)
    // index. The replica's counts only filter; the locked read recounts.
    const page = await dbRead.$queryRaw<Holding[]>`
      SELECT i."itemDefinitionId" AS "boxDefinitionId", i."holderId" AS "userId",
        count(*)::int AS held, d.params
      FROM "Item" i
      JOIN "ItemDefinition" d ON d.id = i."itemDefinitionId"
      WHERE i."holderType" = 'user' AND d.type = ${ITEM_TYPE.box}
        AND d.status = ${ITEM_DEFINITION_STATUS.published}
        AND (i."holderId", i."itemDefinitionId") > (${after.userId}, ${after.boxDefinitionId})
      GROUP BY i."holderId", i."itemDefinitionId", d.params
      ORDER BY i."holderId", i."itemDefinitionId"
      LIMIT ${pageSize}`;
    done = page.length < pageSize;
    for (const holding of page) {
      holdingsChecked++;
      let boxes: { id: bigint; sourceKey: string }[];
      try {
        boxes = await overPoolBoxes(holding, catalogs);
      } catch (error) {
        failed.push({ userId: holding.userId, error: errorMessage(error) });
        continue;
      }
      for (const box of boxes) {
        try {
          // A pack box is only taken back here; its share is paid, and its holder told, below.
          if (parsePackBoxSourceKey(box.sourceKey)) {
            await claimPackBox(box, holding.userId);
            continue;
          }
          const outcome = await refundBoxPurchase({
            buzzTransactionId: box.sourceKey,
            userId: holding.userId,
            reason: 'over-pool',
            actorId: -1,
          });
          if (outcome.status === 'failed') throw new Error(outcome.error);
          if (outcome.status !== 'refunded') continue;
          refunded++;
          await notifyUnopenable(holding.userId, box.sourceKey);
        } catch (error) {
          failed.push({ userId: holding.userId, error: `Box ${box.id}: ${errorMessage(error)}` });
        }
      }
    }
    // The end of the holdings wraps to the start for the next run.
    after = done ? SCAN_START : page[page.length - 1];
    await writeScanCursor(after);
  }

  // Pack boxes this scan took back.
  const scanShares = await payOwedPackShares(failed);
  const backlog = !done;

  if (failed.length || backlog)
    await log('error', 'Over-pool box refunds left work behind', { failed, backlog });
  return {
    holdingsChecked,
    refunded,
    sharesPaid: sharesPaid + scanShares,
    finished,
    takedowns,
    failed,
    backlog,
  };
}

/**
 * Every claimed refund not yet paid back, each tried once per run: one that fails again is stamped
 * and goes behind the rest, so repeat failures never hold up the others.
 */
async function finishOwedRefunds(failed: { userId: number; error: string }[], deadline: number) {
  const tried = new Set<string>();
  let finished = 0;
  while (Date.now() < deadline) {
    const owed = (await listOwedBoxPurchaseRefunds(50)).filter(
      (o) => !tried.has(o.buzzTransactionId)
    );
    if (!owed.length) break;
    for (const purchase of owed) {
      tried.add(purchase.buzzTransactionId);
      const outcome = await refundBoxPurchase({ ...purchase, actorId: -1 });
      if (outcome.status === 'failed')
        failed.push({ userId: purchase.userId, error: outcome.error });
      if (outcome.status !== 'refunded') continue;
      finished++;
      if (purchase.reason === 'over-pool')
        await notifyUnopenable(purchase.userId, purchase.buzzTransactionId);
    }
  }
  return finished;
}
