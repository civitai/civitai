import { sql, type Kysely, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { ensureKeeper } from '../daily/daily.service';
import { utcDay } from '../daily/days';
import { RESET_REASON, SMITES } from './config';

type Executor = Kysely<DB> | Transaction<DB>;

export type ResetDeps = {
  /** Resets the career in the main app. Resolves once it is done or already done; a throw is retried by the tick. */
  resetPlayer: (playerId: number) => Promise<void>;
};

export async function activeSmiteCount(db: Executor, playerId: number): Promise<number> {
  const row = await db
    .selectFrom('NewOrderSmite')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('targetPlayerId', '=', playerId)
    .where('cleansedAt', 'is', null)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/** Writes the penalty to the table both games read for vote weight. Returns the active count including it. */
export async function issueSmite(
  trx: Executor,
  {
    playerId,
    reason,
    size = SMITES.size,
    now,
  }: { playerId: number; reason: string; size?: number; now: Date }
): Promise<number> {
  await trx
    .insertInto('NewOrderSmite')
    .values({
      targetPlayerId: playerId,
      givenById: SMITES.systemGiverId,
      reason,
      size,
      remaining: size,
      createdAt: utc(now),
    })
    .execute();
  return activeSmiteCount(trx, playerId);
}

/** One correct, graded vote works every active smite down by one, as the original game does; a smite at 0 is cleansed. */
export async function workOffSmites(trx: Executor, playerId: number, now: Date): Promise<void> {
  await trx
    .updateTable('NewOrderSmite')
    .set({
      remaining: sql<number>`"remaining" - 1`,
      cleansedAt: sql<Date | null>`CASE WHEN "remaining" - 1 <= 0 THEN ${utc(now)} ELSE NULL END`,
      cleansedReason: sql<
        string | null
      >`CASE WHEN "remaining" - 1 <= 0 THEN 'Smite expired' ELSE NULL END`,
    })
    .where('targetPlayerId', '=', playerId)
    .where('cleansedAt', 'is', null)
    .execute();
}

/** Lapses old smites, as the original game's nightly job does. */
export async function expireSmites(db: Executor, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - SMITES.expireAfterDays * 86_400_000);
  const rows = await db
    .updateTable('NewOrderSmite')
    .set({ cleansedAt: utc(now), cleansedReason: 'Smite expired' })
    .where('cleansedAt', 'is', null)
    .where('createdAt', '<=', utc(cutoff))
    .returning('id')
    .execute();
  return rows.length;
}

export async function playersDueForReset(db: Executor, limit = 100): Promise<number[]> {
  const rows = await db
    .selectFrom('NewOrderSmite')
    .select('targetPlayerId')
    .where('cleansedAt', 'is', null)
    .groupBy('targetPlayerId')
    .having((eb) => eb.fn.countAll(), '>=', SMITES.max)
    .orderBy('targetPlayerId', 'asc')
    .limit(limit)
    .execute();
  return rows.map((r) => r.targetPlayerId);
}

/** Resets one player now. Returns false when the main app could not: the smites stay active, so the tick finds the player again. */
export async function resetNow(playerId: number, deps: ResetDeps): Promise<boolean> {
  try {
    await deps.resetPlayer(playerId);
    return true;
  } catch (error) {
    console.error('knights: career reset failed, the tick will retry it', { playerId, error });
    return false;
  }
}

export async function resetPendingPlayers(
  db: Kysely<DB>,
  deps: ResetDeps
): Promise<{ due: number; failed: number }> {
  const due = await playersDueForReset(db);
  let failed = 0;
  for (const playerId of due) if (!(await resetNow(playerId, deps))) failed++;
  return { due: due.length, failed };
}

/** True from the reset until the player dismisses the notice. */
export async function hasUnseenReset(db: Executor, playerId: number): Promise<boolean> {
  const row = await db
    .selectFrom('NewOrderSmite as s')
    .select('s.id')
    .where('s.targetPlayerId', '=', playerId)
    .where('s.cleansedReason', '=', RESET_REASON)
    .where(
      sql<boolean>`s."cleansedAt" > COALESCE((SELECT "resetNoticeSeenAt" FROM "KnightsPlayer" WHERE "playerId" = s."targetPlayerId"), 'epoch')`
    )
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export async function dismissResetNotice(db: Executor, playerId: number, now: Date): Promise<void> {
  await ensureKeeper(db, playerId, utcDay(now));
  await db
    .updateTable('KnightsPlayer')
    .set({ resetNoticeSeenAt: utc(now) })
    .where('playerId', '=', playerId)
    .execute();
}
