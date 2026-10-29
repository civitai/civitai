import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { BuzzRejectedError, type BuzzPort } from './buzz';
import { CONVERSION, PENDING_CONVERSION_RETRY_AFTER_MS } from './config';
import { heldSql } from './held';

type Conversion = Selectable<DB['KnightsGoldConversion']>;
type Log = (event: Record<string, unknown>) => unknown;

export type ConvertResult =
  | { status: 'converted'; gold: number; buzz: number; transactionId: string | null }
  /** Buzz did not confirm; the gold stays reserved and a retry sends the same key. */
  | { status: 'pending'; gold: number; buzz: number }
  /** Buzz refused it for good: the gold is convertible again, unless a career reset forfeited it (`forfeited`). */
  | { status: 'failed'; gold: number; buzz: number; forfeited: boolean }
  | { status: 'refused'; reason: 'no-player' | 'held' | 'below-minimum' };

type Refusal = Extract<ConvertResult, { status: 'refused' }>['reason'];
type Reserved = { refused: Refusal } | { conversion: Conversion };

/** Two steps: reserve the gold under the player's row lock, then ask Buzz with the reservation's own key. An unknown outcome leaves it pending, and every retry sends the same key; a definitive rejection marks it failed and releases the gold. */
export async function convertGold(
  db: Kysely<DB>,
  buzz: BuzzPort,
  { playerId, now, log }: { playerId: number; now: Date; log?: Log }
): Promise<ConvertResult> {
  const reserved: Reserved = await db.transaction().execute(async (trx): Promise<Reserved> => {
    const player = await trx
      .selectFrom('NewOrderPlayer as p')
      .select(['p.goldCleared', 'p.goldConverted', heldSql('p.userId').as('held')])
      .where('p.userId', '=', playerId)
      .forUpdate()
      .executeTakeFirst();
    if (!player) return { refused: 'no-player' };
    if (player.held) return { refused: 'held' };

    const open = await trx
      .selectFrom('KnightsGoldConversion')
      .selectAll()
      .where('playerId', '=', playerId)
      .where('status', '=', 'pending')
      .orderBy('id', 'asc')
      .executeTakeFirst();
    if (open) return { conversion: open };

    const buzzAmount = Math.floor(
      Math.max(0, player.goldCleared - player.goldConverted) / CONVERSION.goldPerBuzz
    );
    if (buzzAmount < CONVERSION.minBuzz) return { refused: 'below-minimum' };
    const gold = buzzAmount * CONVERSION.goldPerBuzz;

    const conversion = await trx
      .insertInto('KnightsGoldConversion')
      .values({
        playerId,
        gold,
        buzz: buzzAmount,
        status: 'pending',
        externalTransactionId: `knights-gold-conversion:${randomUUID()}`,
        // stamped after the player row lock, on the clock a reset's startAt uses
        createdAt: sql<Date>`clock_timestamp()`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await trx
      .updateTable('NewOrderPlayer')
      .set({ goldConverted: sql<number>`"goldConverted" + ${gold}` })
      .where('userId', '=', playerId)
      .execute();
    return { conversion };
  });

  if ('refused' in reserved) return { status: 'refused', reason: reserved.refused };
  return settleConversion(db, buzz, reserved.conversion, { now, log });
}

/** Marks a conversion paid. Never overwrites a Buzz transaction id already stored, and fills in one a duplicate answer left empty. */
export async function markConversionPaid(
  db: Kysely<DB>,
  conversionId: number,
  transactionId: string | null,
  now: Date
) {
  await db
    .updateTable('KnightsGoldConversion')
    .set({
      status: 'paid',
      buzzTransactionId: sql<string | null>`COALESCE("buzzTransactionId", ${transactionId})`,
      paidAt: sql<Date>`COALESCE("paidAt", ${utc(now)})`,
    })
    .where('id', '=', conversionId)
    .where('status', 'in', ['pending', 'paid'])
    .execute();
}

/** Marks a pending conversion failed and gives its gold back, in one transaction. Gold reserved before a career reset was forfeited by it, so it is forfeited here too rather than given back; a tie at the clock's millisecond counts as before the reset. */
async function failConversion(db: Kysely<DB>, conversion: Conversion): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const player = await trx
      .selectFrom('NewOrderPlayer')
      .select('startAt')
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
    const forfeited = player !== undefined && conversion.createdAt <= player.startAt;
    const gold = conversion.gold;
    await trx
      .updateTable('NewOrderPlayer')
      .set({
        goldConverted: sql<number>`GREATEST(0, "goldConverted" - ${gold})`,
        ...(forfeited
          ? {
              goldEarned: sql<number>`GREATEST(0, "goldEarned" - ${gold})`,
              goldCleared: sql<number>`GREATEST(0, "goldCleared" - ${gold})`,
            }
          : {}),
      })
      .where('userId', '=', conversion.playerId)
      .execute();
    return forfeited;
  });
}

async function settleConversion(
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
      await log?.({
        type: 'error',
        name: 'knights-gold-conversion-rejected',
        details: { conversionId: conversion.id, status: error.status, forfeited },
        message: 'Buzz rejected a gold conversion; the gold was released',
      });
      return { status: 'failed', gold, buzz: amount, forfeited };
    }
    await log?.({
      type: 'warning',
      name: 'knights-gold-conversion-unconfirmed',
      details: { conversionId: conversion.id, error: String(error) },
      message: 'Buzz did not confirm a gold conversion; it will be retried',
    });
    return { status: 'pending', gold, buzz: amount };
  }
  await markConversionPaid(db, conversion.id, transactionId, now);
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
