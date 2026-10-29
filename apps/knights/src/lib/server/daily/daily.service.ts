import { sql, type Kysely, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { isRank, RANK_RULES, type Rank } from '../ranks';
import { DAILY, goldWithinCap, streakBonusGold } from './config';
import { dayLabel, dayStart, nextDayStart, utcDay, type Day } from './days';
import {
  advanceStreak,
  grantWeeklyShield,
  liveStreak,
  newPlayerState,
  type StreakState,
} from './streak';

type Executor = Kysely<DB> | Transaction<DB>;

const dateOf = (day: Day) => sql<Date>`${day}::date`;

const KEEPER_STATE = [
  'streak',
  'shields',
  sql<string | null>`"lastWatchDay"::text`.as('lastWatchDay'),
  sql<string>`"shieldWeek"::text`.as('shieldWeek'),
] as const;

async function readKeeper(
  db: Executor,
  playerId: number,
  lock = false
): Promise<StreakState | null> {
  let query = db.selectFrom('KnightsPlayer').select(KEEPER_STATE).where('playerId', '=', playerId);
  if (lock) query = query.forUpdate();
  return (await query.executeTakeFirst()) ?? null;
}

async function ensureKeeper(trx: Executor, playerId: number, today: Day) {
  const fresh = newPlayerState(today);
  await trx
    .insertInto('KnightsPlayer')
    .values({ playerId, shields: fresh.shields, shieldWeek: dateOf(fresh.shieldWeek) })
    .onConflict((oc) => oc.column('playerId').doNothing())
    .execute();
}

async function completeWatch(trx: Executor, playerId: number, today: Day): Promise<number> {
  const before = (await readKeeper(trx, playerId, true)) ?? newPlayerState(today);
  const { shieldUsed: _spent, ...after } = advanceStreak(before, today);
  await trx
    .updateTable('KnightsPlayer')
    .set({
      streak: after.streak,
      shields: after.shields,
      lastWatchDay: dateOf(today),
      shieldWeek: dateOf(after.shieldWeek),
    })
    .where('playerId', '=', playerId)
    .execute();
  return streakBonusGold(after.streak);
}

export type DayRecord = { gold: number; bonus: number; watchCompleted: boolean };

/**
 * Counts one vote into the player's UTC day: clamps its gold to what is left of the rank's daily cap
 * and, on the vote that reaches the Watch size, advances the streak and prices the bonus.
 * Call it only after this transaction has locked the player's NewOrderPlayer row: that lock is what
 * serialises one player's concurrent votes, so the day row cannot be overspent or complete twice.
 */
export async function recordVoteDay(
  trx: Executor,
  { playerId, rank, gold, now }: { playerId: number; rank: Rank; gold: number; now: Date }
): Promise<DayRecord> {
  const today = utcDay(now);
  await ensureKeeper(trx, playerId, today);
  await trx
    .insertInto('KnightsPlayerDay')
    .values({ playerId, day: dateOf(today) })
    .onConflict((oc) => oc.columns(['playerId', 'day']).doNothing())
    .execute();
  const row = await trx
    .selectFrom('KnightsPlayerDay')
    .select(['votes', 'goldRecorded', 'watchCompletedAt'])
    .where('playerId', '=', playerId)
    .where('day', '=', dateOf(today))
    .forUpdate()
    .executeTakeFirstOrThrow();

  const recorded = goldWithinCap(rank, row.goldRecorded, gold);
  const votes = row.votes + 1;
  const watchCompleted = row.watchCompletedAt === null && votes >= DAILY.watchSize;
  const bonus = watchCompleted ? await completeWatch(trx, playerId, today) : 0;

  await trx
    .updateTable('KnightsPlayerDay')
    .set({
      votes,
      goldRecorded: row.goldRecorded + recorded,
      ...(watchCompleted ? { watchCompletedAt: utc(now), bonusGold: bonus } : {}),
    })
    .where('playerId', '=', playerId)
    .where('day', '=', dateOf(today))
    .execute();
  return { gold: recorded, bonus, watchCompleted };
}

export type DailyStatus = {
  votes: number;
  watchSize: number;
  watchDone: boolean;
  goldRecorded: number;
  goldCap: number;
  capReached: boolean;
  streak: number;
  shields: number;
  maxShields: number;
  /** Paid when today's Watch completes; what was paid once it has. */
  bonusGold: number;
};

export async function getDailyStatus(
  db: Executor,
  { playerId, rank, now }: { playerId: number; rank: string; now: Date }
): Promise<DailyStatus> {
  const today = utcDay(now);
  const [row, stored] = await Promise.all([
    db
      .selectFrom('KnightsPlayerDay')
      .select(['votes', 'goldRecorded', 'watchCompletedAt', 'bonusGold'])
      .where('playerId', '=', playerId)
      .where('day', '=', dateOf(today))
      .executeTakeFirst(),
    readKeeper(db, playerId),
  ]);
  const state = stored ?? newPlayerState(today);
  const watchDone = row?.watchCompletedAt != null;
  const goldCap = isRank(rank) ? RANK_RULES[rank].dailyGoldCap : 0;
  const goldRecorded = row?.goldRecorded ?? 0;

  return {
    votes: row?.votes ?? 0,
    watchSize: DAILY.watchSize,
    watchDone,
    goldRecorded,
    goldCap,
    capReached: goldCap > 0 && goldRecorded >= goldCap,
    streak: liveStreak(state, today),
    shields: grantWeeklyShield(state, today).shields,
    maxShields: DAILY.maxShields,
    bonusGold: watchDone ? row.bonusGold : streakBonusGold(advanceStreak(state, today).streak),
  };
}

export type Recap = {
  day: Day;
  /** "yesterday" or "on Oct 26" */
  when: string;
  cast: number;
  confirmed: number;
  /** Settled votes with a verdict; the denominator of `accuracy`. */
  graded: number;
  accuracy: number | null;
  goldEarned: number;
  pending: number;
};

/** The player's last play day before today, unless they already dismissed the recap today. */
export async function getRecap(
  db: Executor,
  { playerId, now }: { playerId: number; now: Date }
): Promise<Recap | null> {
  const today = utcDay(now);
  const keeper = await db
    .selectFrom('KnightsPlayer')
    .select(sql<string | null>`"recapDismissedFor"::text`.as('dismissed'))
    .where('playerId', '=', playerId)
    .executeTakeFirst();
  if (keeper?.dismissed === today) return null;

  const last = await db
    .selectFrom('KnightsPlayerDay')
    .select(sql<string>`"day"::text`.as('day'))
    .where('playerId', '=', playerId)
    .where('day', '<', dateOf(today))
    .where('votes', '>', 0)
    .orderBy('day', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!last) return null;

  const totals = await db
    .selectFrom('KnightsVote')
    .select([
      sql<string>`count(*)`.as('cast'),
      sql<string>`count(*) filter (where "settledAt" is not null and "verdict" = 'correct')`.as(
        'confirmed'
      ),
      sql<string>`count(*) filter (where "settledAt" is not null and "verdict" = 'failed')`.as(
        'failed'
      ),
      sql<string>`count(*) filter (where "settledAt" is null)`.as('pending'),
      sql<string>`coalesce(sum("gold") filter (where "settledAt" is not null and "verdict" = 'correct'), 0)`.as(
        'gold'
      ),
    ])
    .where('playerId', '=', playerId)
    .where('createdAt', '>=', utc(dayStart(last.day)))
    .where('createdAt', '<', utc(nextDayStart(last.day)))
    .executeTakeFirstOrThrow();

  const cast = Number(totals.cast);
  if (cast === 0) return null;
  const confirmed = Number(totals.confirmed);
  const graded = confirmed + Number(totals.failed);
  return {
    day: last.day,
    when: dayLabel(last.day, today),
    cast,
    confirmed,
    graded,
    accuracy: graded > 0 ? confirmed / graded : null,
    goldEarned: Number(totals.gold),
    pending: Number(totals.pending),
  };
}

export async function dismissRecap(
  db: Executor,
  { playerId, now }: { playerId: number; now: Date }
): Promise<void> {
  const today = utcDay(now);
  const fresh = newPlayerState(today);
  await db
    .insertInto('KnightsPlayer')
    .values({
      playerId,
      shields: fresh.shields,
      shieldWeek: dateOf(fresh.shieldWeek),
      recapDismissedFor: dateOf(today),
    })
    .onConflict((oc) => oc.column('playerId').doUpdateSet({ recapDismissedFor: dateOf(today) }))
    .execute();
}
