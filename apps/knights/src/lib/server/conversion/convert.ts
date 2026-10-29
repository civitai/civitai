import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Selectable } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { heldSql } from './balance';
import type { BuzzPort } from './buzz';
import { CONVERSION, PENDING_CONVERSION_RETRY_AFTER_MS } from './config';

type Conversion = Selectable<DB['KnightsGoldConversion']>;

export type ConvertResult =
  | { status: 'converted'; gold: number; buzz: number; transactionId: string | null }
  /** Buzz did not confirm. The gold stays reserved and a retry sends the same key, so it is paid once. */
  | { status: 'pending'; gold: number; buzz: number }
  | { status: 'refused'; reason: 'no-player' | 'held' | 'below-minimum' };

type Refusal = Extract<ConvertResult, { status: 'refused' }>['reason'];
type Reserved = { refused: Refusal } | { conversion: Conversion };

/**
 * Converts all of a player's convertible gold, in whole Buzz, in two steps: reserve the gold under the
 * player's row lock, then ask Buzz with the reservation's own key. A try that cannot tell whether Buzz paid
 * leaves the reservation pending, and the next try (the player's, or the tick's) sends the same key.
 */
export async function convertGold(
  db: Kysely<DB>,
  buzz: BuzzPort,
  { playerId, now }: { playerId: number; now: Date }
): Promise<ConvertResult> {
  const reserved: Reserved = await db.transaction().execute(async (trx): Promise<Reserved> => {
    const player = await trx
      .selectFrom('NewOrderPlayer as p')
      .select(['p.goldCleared', 'p.goldConverted', heldSql('p.userId').as('held')])
      .where('p.userId', '=', playerId)
      .forUpdate()
      .executeTakeFirst();
    if (!player) return { refused: 'no-player' as const };
    if (player.held) return { refused: 'held' as const };

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
    if (buzzAmount < CONVERSION.minBuzz) return { refused: 'below-minimum' as const };
    const gold = buzzAmount * CONVERSION.goldPerBuzz;

    const conversion = await trx
      .insertInto('KnightsGoldConversion')
      .values({
        playerId,
        gold,
        buzz: buzzAmount,
        status: 'pending',
        externalTransactionId: `knights-gold-conversion:${randomUUID()}`,
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
  return settleConversion(db, buzz, reserved.conversion, now);
}

/** Asks Buzz to pay a reserved conversion with its own key, then marks it paid. Safe to repeat. */
async function settleConversion(
  db: Kysely<DB>,
  buzz: BuzzPort,
  conversion: Conversion,
  now: Date
): Promise<ConvertResult> {
  let transactionId: string | null;
  try {
    ({ transactionId } = await buzz.grantYellow({
      userId: conversion.playerId,
      amount: conversion.buzz,
      externalTransactionId: conversion.externalTransactionId,
      description: 'Knights of New Order gold conversion',
    }));
  } catch (error) {
    console.error('knights: Buzz did not confirm a gold conversion, it will be retried', {
      conversionId: conversion.id,
      error,
    });
    return { status: 'pending', gold: conversion.gold, buzz: conversion.buzz };
  }
  await db
    .updateTable('KnightsGoldConversion')
    .set({ status: 'paid', buzzTransactionId: transactionId, paidAt: utc(now) })
    .where('id', '=', conversion.id)
    .where('status', '=', 'pending')
    .execute();
  return { status: 'converted', gold: conversion.gold, buzz: conversion.buzz, transactionId };
}

/** Retries reserved conversions Buzz never confirmed. A held player's stay pending until released. */
export async function retryPendingConversions(
  db: Kysely<DB>,
  buzz: BuzzPort,
  { now, limit = 50 }: { now: Date; limit?: number }
): Promise<{ retried: number; paid: number }> {
  const due = await db
    .selectFrom('KnightsGoldConversion as c')
    .selectAll('c')
    .where('c.status', '=', 'pending')
    .where('c.createdAt', '<=', utc(new Date(now.getTime() - PENDING_CONVERSION_RETRY_AFTER_MS)))
    .where(sql<boolean>`NOT ${heldSql('c.playerId')}`)
    .orderBy('c.id', 'asc')
    .limit(limit)
    .execute();
  let paid = 0;
  for (const conversion of due) {
    if ((await settleConversion(db, buzz, conversion, now)).status === 'converted') paid++;
  }
  return { retried: due.length, paid };
}
