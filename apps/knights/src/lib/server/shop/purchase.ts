import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import { withheldCosmetics } from '@civitai/db/knights';
import type { DB } from '@civitai/db-schema/kysely';
import type { BuzzPort } from '../conversion/buzz';
import { spendableOf } from '../conversion/balance';
import { markForfeited, releaseReservation, settleConversion } from '../conversion/convert';
import { heldSql } from '../conversion/held';
import { metrics } from '../metrics';
import { rankIndex } from '../ranks';
import {
  PENDING_PURCHASE_ALERT_ATTEMPTS,
  PENDING_PURCHASE_RETRY_AFTER_MS,
  REQUEST_KEY_PATTERN,
} from './config';
import { holdingBlocksPurchase, stickerUses } from './cosmetics';
import { MainAppRejectedError, type MainAppPort } from './main-app';
import { hasActiveMembership } from './inventory';
import { isSellable, stockFor, utcDay, type ShopItem } from '@civitai/shared/knights-shop';

type Purchase = Selectable<DB['KnightsShopPurchase']>;
type Log = (event: Record<string, unknown>) => unknown;

export type BuyRequest = {
  playerId: number;
  itemId: number;
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
  | 'not-approved'
  | 'insufficient'
  | 'has-membership'
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
  | { purchase: Purchase; replayed: boolean; held: boolean };

const refuse = (
  reason: Refusal,
  shortfall?: number
): { refused: BuyResult & { status: 'refused' } } => ({
  refused:
    shortfall === undefined
      ? { status: 'refused', reason }
      : { status: 'refused', reason, shortfall },
});

/** Reserves the gold under the player's row lock (same spendable rule as conversion), then delivers. An unknown outcome leaves the purchase pending for the tick; a definitive refusal releases the gold. */
export async function buyItem(
  db: Kysely<DB>,
  deps: BuyDeps,
  { playerId, itemId, requestKey, price, now }: BuyRequest
): Promise<BuyResult> {
  if (!REQUEST_KEY_PATTERN.test(requestKey)) return { status: 'refused', reason: 'bad-key' };

  const reserved: Reserved = await db.transaction().execute(async (trx): Promise<Reserved> => {
    const player = await trx
      .selectFrom('NewOrderPlayer as p')
      .select(['p.rankType', 'p.goldEarned', 'p.goldConverted', heldSql('p.userId').as('held')])
      .where('p.userId', '=', playerId)
      .forUpdate()
      .executeTakeFirst();
    if (!player) return refuse('no-player');

    // Before every refusal: a retry of a purchase that was charged gets its own answer, whatever the player or shop became since.
    const replay = await trx
      .selectFrom('KnightsShopPurchase')
      .selectAll()
      .where('playerId', '=', playerId)
      .where('requestKey', '=', requestKey)
      .executeTakeFirst();
    if (replay) {
      return replay.itemId === itemId
        ? { purchase: replay, replayed: true, held: Boolean(player.held) }
        : refuse('bad-key');
    }
    if (player.held) return refuse('held');

    const items = await trx
      .selectFrom('KnightsShopItem')
      .selectAll()
      .where('active', '=', true)
      .execute();
    const day = utcDay(now);
    const sellable: ShopItem[] = items.filter(isSellable);
    const item = sellable.find((entry) => entry.id === itemId);
    if (!item) return refuse('unknown-item');
    // A creator cosmetic still in review cannot be worn, so gold spent on it would buy nothing. It also
    // never took a rotation slot or a deal, as in `loadShop`.
    const withheld = await withheldCosmetics(
      trx,
      sellable.flatMap((s) => (s.cosmeticId === null ? [] : [s.cosmeticId]))
    );
    if (item.cosmeticId !== null && withheld.has(item.cosmeticId)) return refuse('not-approved');
    const catalog = sellable.filter((s) => s.cosmeticId === null || !withheld.has(s.cosmeticId));
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
      const blocked = holdingBlocksPurchase(cosmetic.type, owned);
      if (blocked) return refuse(blocked);
      if (cosmetic.type === 'Sticker') uses = stickerUses(cosmetic.data);
    }

    if (item.kind === 'membership' && (await hasActiveMembership(trx, playerId, now))) {
      return refuse('has-membership');
    }

    const spendable = spendableOf(player);
    if (entry.price > spendable) return refuse('insufficient', entry.price - spendable);

    const externalKey = `knights-shop:${randomUUID()}`;
    const grant =
      item.kind === 'buzz_pack'
        ? { buzz: item.buzz }
        : item.kind === 'cosmetic'
        ? { cosmeticId: item.cosmeticId }
        : { tier: item.tier, days: item.days };

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

    let purchase = await trx
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
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // One clock for both stamps: a cosmetic is granted in the instant it is bought.
    if (item.kind === 'cosmetic') {
      purchase = await trx
        .updateTable('KnightsShopPurchase')
        .set({ grantedAt: sql<Date>`"createdAt"` })
        .where('id', '=', purchase.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }

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
    return { purchase, replayed: false, held: false };
  });

  if ('refused' in reserved) return reserved.refused;
  const { purchase, replayed, held } = reserved;
  const result = await deliver(db, deps, purchase, { replayed, held, now });
  if (!replayed && result.status !== 'refused') {
    metrics.shopPurchase(purchase.kind, result.status, purchase.gold);
  }
  return result;
}

/** Moves a reserved purchase toward delivered, and says where it stands. Safe to repeat: every downstream call carries the purchase's key. */
async function deliver(
  db: Kysely<DB>,
  deps: BuyDeps,
  purchase: Purchase,
  { replayed, held, now }: { replayed: boolean; held: boolean; now: Date }
): Promise<BuyResult> {
  const base = {
    purchaseId: purchase.id,
    replayed,
    kind: purchase.kind,
    gold: purchase.gold,
  };
  const grant = purchase.grant as { buzz?: number; forfeited?: boolean };
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
  if (purchase.status === 'failed') {
    return { status: 'failed', purchaseId: purchase.id, forfeited: grant.forfeited === true };
  }

  // Like the tick, a replay leaves a held player's unconfirmed purchase reserved, and so does the Buzz kill switch.
  if (replayed && held) return { status: 'pending', ...base, buzz: grant.buzz };
  if (purchase.kind === 'buzz_pack') {
    if (!deps.buzzPacksOpen) return { status: 'pending', ...base, buzz: grant.buzz };
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
  return settleMembership(db, deps.mainApp, purchase, { now, replayed, log: deps.log });
}

async function settleMembership(
  db: Kysely<DB>,
  mainApp: MainAppPort,
  purchase: Purchase,
  { now, replayed = false, log }: { now: Date; replayed?: boolean; log?: Log }
): Promise<BuyResult> {
  const base = {
    purchaseId: purchase.id,
    replayed,
    kind: purchase.kind,
    gold: purchase.gold,
  };
  const { tier, days } = purchase.grant as { tier: string; days?: number };
  const { attempts } = await db
    .updateTable('KnightsShopPurchase')
    .set({ lastAttemptAt: utc(now), attempts: sql<number>`"attempts" + 1` })
    .where('id', '=', purchase.id)
    .returning('attempts')
    .executeTakeFirstOrThrow();
  try {
    await mainApp.grantMembership({
      userId: purchase.playerId,
      tier,
      days,
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
    const stuck =
      attempts >= PENDING_PURCHASE_ALERT_ATTEMPTS &&
      attempts % PENDING_PURCHASE_ALERT_ATTEMPTS === 0;
    await log?.({
      type: stuck ? 'error' : 'warning',
      name: stuck ? 'knights-shop-membership-stuck' : 'knights-shop-membership-unconfirmed',
      details: { purchaseId: purchase.id, attempts, error: String(error) },
      message: stuck
        ? 'A membership purchase is still unconfirmed after many tries; its gold stays reserved because the grant may have happened'
        : 'The main app did not confirm a membership purchase; it will be retried',
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

/** See `releaseReservation` for what a career reset forfeits. */
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
    const forfeited = await releaseReservation(trx, {
      playerId: purchase.playerId,
      gold: purchase.gold,
      reservedAt: purchase.createdAt,
    });
    if (forfeited) await markForfeited(trx, purchase.id);
    return forfeited;
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
