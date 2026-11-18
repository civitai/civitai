import { sql, type ExpressionBuilder, type Kysely, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { ensureKeeper } from '../daily/daily.service';
import { utcDay } from '../daily/days';
import { metrics } from '../metrics';
import { ACOLYTE_WRONG_ANSWER_SMITE, SMITES } from './config';

type Executor = Kysely<DB> | Transaction<DB>;

export type ResetDeps = {
  /** Resets the career in the main app. Resolves once it is done or already done; a throw is retried by the tick. */
  resetPlayer: (playerId: number) => Promise<void>;
  /** Whether Acolyte wrong-answer smites are on (saved on the moderator Config page, else `KNIGHTS_APPRENTICE_SMITES`). Without it, they are. */
  acolyteSmites?: () => boolean | Promise<boolean>;
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

/**
 * Progress toward the next heart back: right verdicts work every active smite down at once, so the one with the fewest left
 * clears first. Null with no active smite.
 */
export async function heartBackOf(
  db: Executor,
  playerId: number
): Promise<{ done: number; needed: number } | null> {
  const row = await db
    .selectFrom('NewOrderSmite')
    .select(['size', 'remaining'])
    .where('targetPlayerId', '=', playerId)
    .where('cleansedAt', 'is', null)
    .orderBy('remaining', 'asc')
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  const needed = Math.max(row.size, row.remaining);
  return { done: needed - row.remaining, needed };
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
  metrics.smite();
  return activeSmiteCount(trx, playerId);
}

/** Clears every active smite at once, recording why. */
export async function cleanseSmites(
  trx: Executor,
  { playerId, reason, now }: { playerId: number; reason: string; now: Date }
): Promise<void> {
  await trx
    .updateTable('NewOrderSmite')
    .set({ cleansedAt: utc(now), cleansedReason: reason })
    .where('targetPlayerId', '=', playerId)
    .where('cleansedAt', 'is', null)
    .execute();
}

/**
 * Each correct, graded vote works every active smite down by one, as the original game does; `correct` is how many were settled
 * together. A smite at 0 is cleansed.
 */
export async function workOffSmites(
  trx: Executor,
  playerId: number,
  now: Date,
  correct = 1
): Promise<void> {
  if (correct <= 0) return;
  await trx
    .updateTable('NewOrderSmite')
    .set({
      remaining: sql<number>`GREATEST(0, "remaining" - ${correct})`,
      cleansedAt: sql<Date | null>`CASE WHEN "remaining" - ${correct} <= 0 THEN ${utc(
        now
      )} ELSE NULL END`,
      cleansedReason: sql<
        string | null
      >`CASE WHEN "remaining" - ${correct} <= 0 THEN 'Smite expired' ELSE NULL END`,
    })
    .where('targetPlayerId', '=', playerId)
    .where('cleansedAt', 'is', null)
    .execute();
}

/**
 * Lapses old smites, as the original game's nightly job does, except for a player whose reset is still due: expiry must not
 * undo it. The affected players are locked in id order first, the order votes and settlement take them in.
 */
export async function expireSmites(
  db: Kysely<DB>,
  now: Date,
  hold: HoldOption = {}
): Promise<number> {
  const cutoff = new Date(now.getTime() - SMITES.expireAfterDays * 86_400_000);
  const resetDue = (eb: ExpressionBuilder<DB, 'NewOrderSmite'>) =>
    eb('targetPlayerId', 'in', dueForReset(db, hold));

  return db.transaction().execute(async (trx) => {
    const players = await trx
      .selectFrom('NewOrderSmite')
      .select('targetPlayerId')
      .distinct()
      .where('cleansedAt', 'is', null)
      .where('createdAt', '<=', utc(cutoff))
      .orderBy('targetPlayerId', 'asc')
      .execute();
    if (players.length === 0) return 0;
    await trx
      .selectFrom('NewOrderPlayer')
      .select('userId')
      .where(
        'userId',
        'in',
        players.map((p) => p.targetPlayerId)
      )
      .orderBy('userId', 'asc')
      .forUpdate()
      .execute();
    const rows = await trx
      .updateTable('NewOrderSmite')
      .set({ cleansedAt: utc(now), cleansedReason: 'Smite expired' })
      .where('cleansedAt', 'is', null)
      .where('createdAt', '<=', utc(cutoff))
      .where((eb) => eb.not(resetDue(eb)))
      .returning('id')
      .execute();
    return rows.length;
  });
}

type HoldOption = {
  /** Leaves out Acolytes whose active smites are all wrong-answer smites (`KNIGHTS_APPRENTICE_SMITES=off`). */
  holdAcolyteWrongAnswer?: boolean;
};

/** Players whose active smites make a career reset due. */
function dueForReset(db: Executor, { holdAcolyteWrongAnswer = false }: HoldOption) {
  let query = db
    .selectFrom('NewOrderSmite as s')
    .select('s.targetPlayerId')
    .where('s.cleansedAt', 'is', null)
    .groupBy('s.targetPlayerId')
    .having((eb) => eb.fn.countAll(), '>=', SMITES.max);
  if (holdAcolyteWrongAnswer) {
    query = query.having((eb) =>
      eb.not(
        eb.and([
          sql<boolean>`bool_and(s."reason" IS NOT DISTINCT FROM ${ACOLYTE_WRONG_ANSWER_SMITE})`,
          eb.exists(
            eb
              .selectFrom('NewOrderPlayer as p')
              .select(sql`1`.as('one'))
              .whereRef('p.userId', '=', 's.targetPlayerId')
              .where('p.rankType', '=', 'Acolyte')
          ),
        ])
      )
    );
  }
  return query;
}

export async function playersDueForReset(
  db: Executor,
  { limit = 100, ...hold }: { limit?: number } & HoldOption = {}
): Promise<number[]> {
  const rows = await dueForReset(db, hold)
    .orderBy('s.targetPlayerId', 'asc')
    .limit(limit)
    .execute();
  return rows.map((r) => r.targetPlayerId);
}

/** Resets one player now. Returns false when the main app could not: the smites stay active, so the tick finds the player again. */
export async function resetNow(playerId: number, deps: ResetDeps): Promise<boolean> {
  try {
    await deps.resetPlayer(playerId);
    metrics.careerReset(playerId, 'smites');
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
  const due = await playersDueForReset(db, {
    holdAcolyteWrongAnswer: (await deps.acolyteSmites?.()) === false,
  });
  let failed = 0;
  for (const playerId of due) if (!(await resetNow(playerId, deps))) failed++;
  return { due: due.length, failed };
}

/**
 * Whether the player's career was reset since they last looked. A reset moves `NewOrderPlayer.startAt`, whoever did it
 * and whenever it landed. The first look only records where they stand, so resets from before then stay quiet.
 */
export async function hasUnseenReset(db: Executor, playerId: number, now: Date): Promise<boolean> {
  const player = await db
    .selectFrom('NewOrderPlayer as p')
    .leftJoin('KnightsPlayer as k', 'k.playerId', 'p.userId')
    .select(['p.startAt', 'k.startAtSeen', 'k.playerId as keeper'])
    .where('p.userId', '=', playerId)
    .executeTakeFirst();
  if (!player) return false;
  if (player.startAtSeen) return player.startAt > player.startAtSeen;

  if (!player.keeper) await ensureKeeper(db, playerId, utcDay(now));
  await db
    .updateTable('KnightsPlayer')
    .set({ startAtSeen: utc(player.startAt) })
    .where('playerId', '=', playerId)
    .where('startAtSeen', 'is', null)
    .execute();
  return false;
}

export async function dismissResetNotice(db: Executor, playerId: number, now: Date): Promise<void> {
  await ensureKeeper(db, playerId, utcDay(now));
  await db
    .updateTable('KnightsPlayer')
    .set({
      startAtSeen: sql<Date>`(SELECT "startAt" FROM "NewOrderPlayer" WHERE "userId" = ${playerId})`,
    })
    .where('playerId', '=', playerId)
    .execute();
}
