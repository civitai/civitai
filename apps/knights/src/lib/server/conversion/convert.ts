import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { BuzzRejectedError, type BuzzPort } from './buzz';
import { PENDING_CONVERSION_RETRY_AFTER_MS } from './config';
import { heldSql } from './held';
import { metrics } from '../metrics';

type Conversion = Selectable<DB['KnightsGoldConversion']>;
type Log = (event: Record<string, unknown>) => unknown;

export type ConvertResult =
  | { status: 'converted'; gold: number; buzz: number; transactionId: string | null }
  /** Buzz did not confirm; the gold stays reserved and a retry sends the same key. */
  | { status: 'pending'; gold: number; buzz: number }
  /** Buzz refused it for good: the gold is convertible again, unless a career reset forfeited it (`forfeited`). */
  | { status: 'failed'; gold: number; buzz: number; forfeited: boolean };

/** Marks a conversion paid. Never overwrites a Buzz transaction id already stored, and fills in one a duplicate answer left empty. */
export async function markConversionPaid(
  db: Kysely<DB>,
  conversionId: number,
  transactionId: string | null,
  now: Date
) {
  // One transaction: a shop Buzz pack rides on a conversion and is granted exactly when the conversion is paid.
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable('KnightsGoldConversion')
      .set({
        status: 'paid',
        buzzTransactionId: sql<string | null>`COALESCE("buzzTransactionId", ${transactionId})`,
        paidAt: sql<Date>`COALESCE("paidAt", ${utc(now)})`,
      })
      .where('id', '=', conversionId)
      .where('status', 'in', ['pending', 'paid'])
      .execute();
    await trx
      .updateTable('KnightsShopPurchase')
      .set({ status: 'granted', grantedAt: sql<Date>`COALESCE("grantedAt", ${utc(now)})` })
      .where('conversionId', '=', conversionId)
      .where('status', '=', 'pending')
      .execute();
  });
}

/**
 * Gives back gold a reservation took, in the caller's transaction (which holds the player's row lock). Gold reserved
 * at or before a career reset's `startAt` was forfeited by it, so it is forfeited here too rather than given back; a
 * tie at the clock's millisecond counts as before the reset. Returns whether it was forfeited.
 */
export async function releaseReservation(
  trx: Transaction<DB>,
  { playerId, gold, reservedAt }: { playerId: number; gold: number; reservedAt: Date }
): Promise<boolean> {
  const player = await trx
    .selectFrom('NewOrderPlayer')
    .select('startAt')
    .where('userId', '=', playerId)
    .executeTakeFirst();
  const forfeited = player !== undefined && reservedAt <= player.startAt;
  await trx
    .updateTable('NewOrderPlayer')
    .set({
      goldConverted: sql<number>`GREATEST(0, "goldConverted" - ${gold})`,
      ...(forfeited ? { goldEarned: sql<number>`GREATEST(0, "goldEarned" - ${gold})` } : {}),
    })
    .where('userId', '=', playerId)
    .execute();
  return forfeited;
}

/** A failed shop purchase says whether its gold was forfeited, so a replay of it reports the same thing. */
export async function markForfeited(trx: Transaction<DB>, purchaseId: number) {
  await trx
    .updateTable('KnightsShopPurchase')
    .set({ grant: sql<never>`"grant" || '{"forfeited": true}'::jsonb` })
    .where('id', '=', purchaseId)
    .execute();
}

/** See `releaseReservation` for what a career reset forfeits. */
async function failConversion(db: Kysely<DB>, conversion: Conversion): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    await trx
      .selectFrom('NewOrderPlayer')
      .select('userId')
      .where('userId', '=', conversion.playerId)
      .forUpdate()
      .executeTakeFirst();
    const failed = await trx
      .updateTable('KnightsGoldConversion')
      .set({ status: 'failed' })
      .where('id', '=', conversion.id)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (Number(failed.numUpdatedRows) === 0) return false;
    const purchase = await trx
      .updateTable('KnightsShopPurchase')
      .set({ status: 'failed' })
      .where('conversionId', '=', conversion.id)
      .where('status', '=', 'pending')
      .returning('id')
      .executeTakeFirst();
    const forfeited = await releaseReservation(trx, {
      playerId: conversion.playerId,
      gold: conversion.gold,
      reservedAt: conversion.createdAt,
    });
    if (forfeited && purchase) await markForfeited(trx, purchase.id);
    return forfeited;
  });
}

export async function settleConversion(
  db: Kysely<DB>,
  buzz: BuzzPort,
  conversion: Conversion,
  { now, log }: { now: Date; log?: Log }
): Promise<ConvertResult> {
  const { gold, buzz: amount } = conversion;
  await db
    .updateTable('KnightsGoldConversion')
    .set({ lastAttemptAt: utc(now) })
    .where('id', '=', conversion.id)
    .execute();
  let transactionId: string | null;
  try {
    ({ transactionId } = await buzz.grantYellow({
      userId: conversion.playerId,
      amount,
      externalTransactionId: conversion.externalTransactionId,
      description: 'Knights of New Order gold conversion',
    }));
  } catch (error) {
    if (error instanceof BuzzRejectedError) {
      const forfeited = await failConversion(db, conversion);
      metrics.buzzGrant('failed');
      await log?.({
        type: 'error',
        name: 'knights-gold-conversion-rejected',
        details: { conversionId: conversion.id, status: error.status, forfeited },
        message: 'Buzz rejected a gold conversion; the gold was released',
      });
      return { status: 'failed', gold, buzz: amount, forfeited };
    }
    metrics.buzzGrant('retry');
    await log?.({
      type: 'warning',
      name: 'knights-gold-conversion-unconfirmed',
      details: { conversionId: conversion.id, error: String(error) },
      message: 'Buzz did not confirm a gold conversion; it will be retried',
    });
    return { status: 'pending', gold, buzz: amount };
  }
  await markConversionPaid(db, conversion.id, transactionId, now);
  metrics.buzzGrant('paid');
  return { status: 'converted', gold, buzz: amount, transactionId };
}

/** Retries reserved conversions Buzz never confirmed. A held player's stay pending until released. */
export async function retryPendingConversions(
  db: Kysely<DB>,
  buzz: BuzzPort,
  {
    now,
    limit = 50,
    budgetMs = Infinity,
    attemptMs = 0,
    log,
  }: { now: Date; limit?: number; budgetMs?: number; attemptMs?: number; log?: Log }
): Promise<{ retried: number; paid: number; failed: number }> {
  const due = await db
    .selectFrom('KnightsGoldConversion as c')
    .selectAll('c')
    .where('c.status', '=', 'pending')
    .where('c.createdAt', '<=', utc(new Date(now.getTime() - PENDING_CONVERSION_RETRY_AFTER_MS)))
    .where(sql<boolean>`NOT ${heldSql('c.playerId')}`)
    .where((eb) =>
      eb.or([
        eb('c.lastAttemptAt', 'is', null),
        eb(
          'c.lastAttemptAt',
          '<=',
          utc(new Date(now.getTime() - PENDING_CONVERSION_RETRY_AFTER_MS))
        ),
      ])
    )
    .orderBy(sql`COALESCE(c."lastAttemptAt", c."createdAt")`, 'asc')
    .orderBy('c.id', 'asc')
    .limit(limit)
    .execute();
  const deadline = Date.now() + budgetMs;
  let retried = 0;
  let paid = 0;
  let failed = 0;
  for (const conversion of due) {
    if (deadline - Date.now() < Math.max(attemptMs, 1)) break;
    retried++;
    try {
      const { status } = await settleConversion(db, buzz, conversion, { now, log });
      if (status === 'converted') paid++;
      if (status === 'failed') failed++;
    } catch (error) {
      // one row's database error must not stop the rest; it stays pending for the next tick
      await log?.({
        type: 'error',
        name: 'knights-gold-conversion-retry-error',
        details: { conversionId: conversion.id, error: String(error) },
        message: 'A pending gold conversion could not be settled',
      });
    }
  }
  return { retried, paid, failed };
}
