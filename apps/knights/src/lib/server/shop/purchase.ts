import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import type { BuzzPort } from '../conversion/buzz';
import { releaseReservation, settleConversion } from '../conversion/convert';
import { heldSql } from '../conversion/held';
import { rankIndex } from '../ranks';
import { PENDING_PURCHASE_RETRY_AFTER_MS } from './config';
import { MainAppRejectedError, type MainAppPort } from './main-app';
import { stockFor, utcDay, type ShopItem } from './rotation';

type Purchase = Selectable<DB['KnightsShopPurchase']>;
type Log = (event: Record<string, unknown>) => unknown;

export type BuyRequest = {
  playerId: number;
  itemId: string;
  /** The buyer's idempotency key: a repeat of it replays the first answer and never charges twice. */
  requestKey: string;
  /** The price the buyer saw; a different current price refuses the purchase. */
  price: number;
  now: Date;
};

export type BuyDeps = {
  buzz: BuzzPort;
  mainApp: MainAppPort;
  /** False while the Buzz kill switch is on: Buzz packs are refused, everything else still sells. */
  buzzPacksOpen: boolean;
  log?: Log;
};

export type Refusal =
  | 'no-player'
  | 'held'
  | 'closed'
  | 'unknown-item'
  | 'not-in-stock'
  | 'price-changed'
  | 'rank'
  | 'sold-out'
  | 'owned'
  | 'unlimited'
  | 'insufficient'
  | 'bad-key';

export type BuyResult =
  | {
      status: 'granted' | 'pending';
      purchaseId: number;
      replayed: boolean;
      kind: string;
      gold: number;
      buzz?: number;
    }
  /** Refused for good downstream; the gold is back unless a career reset forfeited it. */
  | { status: 'failed'; purchaseId: number; forfeited: boolean }
  | { status: 'refused'; reason: Refusal; shortfall?: number };

type Reserved =
  | { refused: BuyResult & { status: 'refused' } }
  | { purchase: Purchase; replayed: boolean };

/** A sticker with no `uses` is unlimited; with `uses`, each purchase is a row holding that many. */
const stickerUses = (data: unknown): number | null => {
  const uses = (data as { uses?: unknown } | null)?.uses;
  return typeof uses === 'number' && Number.isFinite(uses) && uses > 0 ? Math.floor(uses) : null;
};

const refuse = (
  reason: Refusal,
  shortfall?: number
): { refused: BuyResult & { status: 'refused' } } => ({
  refused:
    shortfall === undefined
      ? { status: 'refused', reason }
      : { status: 'refused', reason, shortfall },
});

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Buys one item with gold. Two steps, like a conversion: reserve the gold under the player's row lock (the same
 * spendable rule, hold check and `goldConverted` counter conversion uses), then deliver. A cosmetic is inserted in the
 * reserving transaction itself. A Buzz pack becomes a `KnightsGoldConversion` and the existing grant and retry
 * path; membership is asked of the main app with the purchase's key. An unknown outcome leaves the purchase pending
 * for the tick, and a definitive refusal releases the gold.
 */
export async function buyItem(
  db: Kysely<DB>,
  deps: BuyDeps,
  { playerId, itemId, requestKey, price, now }: BuyRequest
): Promise<BuyResult> {
  if (!KEY_PATTERN.test(requestKey)) return { status: 'refused', reason: 'bad-key' };

  const reserved: Reserved = await db.transaction().execute(async (trx): Promise<Reserved> => {
    const player = await trx
      .selectFrom('NewOrderPlayer as p')
      .select(['p.rankType', 'p.goldEarned', 'p.goldConverted', heldSql('p.userId').as('held')])
      .where('p.userId', '=', playerId)
      .forUpdate()
      .executeTakeFirst();
    if (!player) return refuse('no-player');
    if (player.held) return refuse('held');

    const replay = await trx
      .selectFrom('KnightsShopPurchase')
      .selectAll()
      .where('playerId', '=', playerId)
      .where('requestKey', '=', requestKey)
      .executeTakeFirst();
    if (replay)
      return replay.itemId === itemId ? { purchase: replay, replayed: true } : refuse('bad-key');

    const items = await trx
      .selectFrom('KnightsShopItem')
      .selectAll()
      .where('active', '=', true)
      .execute();
    const day = utcDay(now);
    const catalog: ShopItem[] = items;
    const item = catalog.find((entry) => entry.id === itemId);
    if (!item) return refuse('unknown-item');
    const entry = stockFor(catalog, day).stock.find((s) => s.item.id === itemId);
    if (!entry) return refuse('not-in-stock');
    if (entry.price !== price) return refuse('price-changed');
    if (item.kind === 'buzz_pack' && !deps.buzzPacksOpen) return refuse('closed');
    if (item.minRank && rankIndex(player.rankType) < rankIndex(item.minRank)) return refuse('rank');

    if (entry.deal) {
      const taken = await trx
        .selectFrom('KnightsShopPurchase')
        .select('id')
        .where('playerId', '=', playerId)
        .where('itemId', '=', itemId)
        .where(sql<boolean>`"dealDay" = ${day}::date`)
        .where('status', '<>', 'failed')
        .executeTakeFirst();
      if (taken) return refuse('sold-out');
    }

    let uses: number | null = null;
    if (item.kind === 'cosmetic') {
      const cosmetic = await trx
        .selectFrom('Cosmetic')
        .select(['type', 'data'])
        .where('id', '=', item.cosmeticId!)
        .executeTakeFirst();
      if (!cosmetic) return refuse('unknown-item');
      const owned = await trx
        .selectFrom('UserCosmetic')
        .select('remaining')
        .where('userId', '=', playerId)
        .where('cosmeticId', '=', item.cosmeticId!)
        .execute();
      if (cosmetic.type === 'Sticker') {
        // Repeat sticker purchases add rows with their own uses; there is nothing to add to once a holding is unlimited.
        if (owned.some((row) => row.remaining === null)) return refuse('unlimited');
        uses = stickerUses(cosmetic.data);
      } else if (owned.length > 0) {
        return refuse('owned');
      }
    }

    const spendable = Math.max(0, player.goldEarned - player.goldConverted);
    if (entry.price > spendable) return refuse('insufficient', entry.price - spendable);

    const externalKey = `knights-shop:${randomUUID()}`;
    const grant =
      item.kind === 'buzz_pack'
        ? { buzz: item.buzz }
        : item.kind === 'cosmetic'
        ? { cosmeticId: item.cosmeticId }
        : { tier: item.tier, months: item.months };

    let conversionId: number | null = null;
    if (item.kind === 'buzz_pack') {
      const conversion = await trx
        .insertInto('KnightsGoldConversion')
        .values({
          playerId,
          gold: entry.price,
          buzz: item.buzz!,
          status: 'pending',
          externalTransactionId: `knights-gold-conversion:${randomUUID()}`,
          createdAt: sql<Date>`clock_timestamp()`,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      conversionId = conversion.id;
    }

    const purchase = await trx
      .insertInto('KnightsShopPurchase')
      .values({
        playerId,
        requestKey,
        externalKey,
        itemId,
        kind: item.kind,
        gold: entry.price,
        grant: JSON.stringify(grant),
        status: item.kind === 'cosmetic' ? 'granted' : 'pending',
        conversionId,
        dealDay: entry.deal ? sql<Date>`${day}::date` : null,
        createdAt: sql<Date>`clock_timestamp()`,
        grantedAt: item.kind === 'cosmetic' ? utc(now) : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .updateTable('NewOrderPlayer')
      .set({ goldConverted: sql<number>`"goldConverted" + ${entry.price}` })
      .where('userId', '=', playerId)
      .execute();

    if (item.kind === 'cosmetic') {
      await trx
        .insertInto('UserCosmetic')
        .values({
          userId: playerId,
          cosmeticId: item.cosmeticId!,
          claimKey: externalKey,
          remaining: uses,
        })
        .execute();
    }
    return { purchase, replayed: false };
  });

  if ('refused' in reserved) return reserved.refused;
  const { purchase, replayed } = reserved;
  return deliver(db, deps, purchase, { replayed, now });
}

/** Moves a reserved purchase toward delivered, and says where it stands. Safe to repeat: every downstream call carries the purchase's key. */
async function deliver(
  db: Kysely<DB>,
  deps: BuyDeps,
  purchase: Purchase,
  { replayed, now }: { replayed: boolean; now: Date }
): Promise<BuyResult> {
  const base = {
    purchaseId: purchase.id,
    replayed,
    kind: purchase.kind,
    gold: purchase.gold,
  };
  const grant = purchase.grant as { buzz?: number };
  if (purchase.status === 'granted') {
    if (!replayed && purchase.kind === 'cosmetic') {
      await deps.mainApp.refreshCosmetics(purchase.playerId).catch((error) =>
        deps.log?.({
          type: 'warning',
          name: 'knights-shop-cache-refresh-failed',
          details: { purchaseId: purchase.id, error: String(error) },
          message: 'A cosmetic was granted but the main app caches were not refreshed',
        })
      );
    }
    return { status: 'granted', ...base };
  }
  if (purchase.status === 'failed')
    return { status: 'failed', purchaseId: purchase.id, forfeited: false };

  if (purchase.kind === 'buzz_pack') {
    const conversion = await db
      .selectFrom('KnightsGoldConversion')
      .selectAll()
      .where('id', '=', purchase.conversionId!)
      .executeTakeFirstOrThrow();
    const result = await settleConversion(db, deps.buzz, conversion, { now, log: deps.log });
    if (result.status === 'converted') return { status: 'granted', ...base, buzz: grant.buzz };
    if (result.status === 'failed') {
      return { status: 'failed', purchaseId: purchase.id, forfeited: result.forfeited };
    }
    return { status: 'pending', ...base, buzz: grant.buzz };
  }
  return settleMembership(db, deps.mainApp, purchase, { now, log: deps.log });
}

async function settleMembership(
  db: Kysely<DB>,
  mainApp: MainAppPort,
  purchase: Purchase,
  { now, log }: { now: Date; log?: Log }
): Promise<BuyResult> {
  const base = {
    purchaseId: purchase.id,
    replayed: false,
    kind: purchase.kind,
    gold: purchase.gold,
  };
  const { tier, months } = purchase.grant as { tier: string; months: number };
  await db
    .updateTable('KnightsShopPurchase')
    .set({ lastAttemptAt: utc(now), attempts: sql<number>`"attempts" + 1` })
    .where('id', '=', purchase.id)
    .execute();
  try {
    await mainApp.grantMembership({
      userId: purchase.playerId,
      tier,
      months,
      key: purchase.externalKey,
    });
  } catch (error) {
    if (error instanceof MainAppRejectedError) {
      const forfeited = await failPurchase(db, purchase);
      await log?.({
        type: 'error',
        name: 'knights-shop-membership-rejected',
        details: { purchaseId: purchase.id, status: error.status, reason: error.reason, forfeited },
        message: 'The main app refused a membership purchase; the gold was released',
      });
      return { status: 'failed', purchaseId: purchase.id, forfeited };
    }
    await log?.({
      type: 'warning',
      name: 'knights-shop-membership-unconfirmed',
      details: { purchaseId: purchase.id, error: String(error) },
      message: 'The main app did not confirm a membership purchase; it will be retried',
    });
    return { status: 'pending', ...base };
  }
  await db
    .updateTable('KnightsShopPurchase')
    .set({ status: 'granted', grantedAt: sql<Date>`COALESCE("grantedAt", ${utc(now)})` })
    .where('id', '=', purchase.id)
    .where('status', '=', 'pending')
    .execute();
  return { status: 'granted', ...base };
}

/** Marks a pending purchase failed and releases its gold, in one transaction; see `releaseReservation`. */
async function failPurchase(db: Kysely<DB>, purchase: Purchase): Promise<boolean> {
  return db.transaction().execute(async (trx: Transaction<DB>) => {
    await trx
      .selectFrom('NewOrderPlayer')
      .select('userId')
      .where('userId', '=', purchase.playerId)
      .forUpdate()
      .executeTakeFirst();
    const failed = await trx
      .updateTable('KnightsShopPurchase')
      .set({ status: 'failed' })
      .where('id', '=', purchase.id)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (Number(failed.numUpdatedRows) === 0) return false;
    return releaseReservation(trx, {
      playerId: purchase.playerId,
      gold: purchase.gold,
      reservedAt: purchase.createdAt,
    });
  });
}

/** Retries membership purchases the main app never confirmed (Buzz packs ride `retryPendingConversions`). A held player's stay pending until released. */
export async function retryPendingPurchases(
  db: Kysely<DB>,
  mainApp: MainAppPort,
  {
    now,
    limit = 50,
    budgetMs = Infinity,
    attemptMs = 0,
    log,
  }: { now: Date; limit?: number; budgetMs?: number; attemptMs?: number; log?: Log }
): Promise<{ retried: number; granted: number; failed: number }> {
  const cutoff = utc(new Date(now.getTime() - PENDING_PURCHASE_RETRY_AFTER_MS));
  const due = await db
    .selectFrom('KnightsShopPurchase as s')
    .selectAll('s')
    .where('s.status', '=', 'pending')
    .where('s.kind', '=', 'membership')
    .where('s.createdAt', '<=', cutoff)
    .where(sql<boolean>`NOT ${heldSql('s.playerId')}`)
    .where((eb) => eb.or([eb('s.lastAttemptAt', 'is', null), eb('s.lastAttemptAt', '<=', cutoff)]))
    .orderBy(sql`COALESCE(s."lastAttemptAt", s."createdAt")`, 'asc')
    .orderBy('s.id', 'asc')
    .limit(limit)
    .execute();
  const deadline = Date.now() + budgetMs;
  let retried = 0;
  let granted = 0;
  let failed = 0;
  for (const purchase of due) {
    if (deadline - Date.now() < Math.max(attemptMs, 1)) break;
    retried++;
    try {
      const { status } = await settleMembership(db, mainApp, purchase, { now, log });
      if (status === 'granted') granted++;
      if (status === 'failed') failed++;
    } catch (error) {
      await log?.({
        type: 'error',
        name: 'knights-shop-retry-error',
        details: { purchaseId: purchase.id, error: String(error) },
        message: 'A pending shop purchase could not be settled',
      });
    }
  }
  return { retried, granted, failed };
}
