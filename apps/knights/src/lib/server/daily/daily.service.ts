import { sql, type Kysely, type Transaction } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { DAILY, dailyGoldCapOf, goldWithinCap, streakBonusGold } from './config';
import { dayLabel, dayStart, nextDayStart, utcDay, type Day } from './days';
import {
  advanceStreak,
  grantWeeklyShield,
  liveStreak,
  newPlayerState,
  shieldCoversToday,
  streakAfterReset,
  watchStands,
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

async function startAtOf(db: Executor, playerId: number): Promise<Date> {
  const player = await db
    .selectFrom('NewOrderPlayer')
    .select('startAt')
    .where('userId', '=', playerId)
    .executeTakeFirst();
  return player?.startAt ?? new Date(0);
}

/**
 * The streak a career reset has not ended. Everything recorded before `startAt` is void: the last
 * Watch must have been completed at or after it. Shields survive the reset.
 */
async function readStreakState(
  db: Executor,
  playerId: number,
  startAt: Date,
  lock = false
): Promise<StreakState | null> {
  const state = await readKeeper(db, playerId, lock);
  if (!state?.lastWatchDay) return state;
  const onResetDay = state.lastWatchDay === utcDay(startAt);
  const last = onResetDay
    ? await db
        .selectFrom('KnightsPlayerDay')
        .select('watchCompletedAt')
        .where('playerId', '=', playerId)
        .where('day', '=', dateOf(state.lastWatchDay))
        .executeTakeFirst()
    : undefined;
  return streakAfterReset(state, startAt, last?.watchCompletedAt ?? null);
}

/**
 * Votes that count toward today's Watch when a reset happened earlier today; null when today is
 * entirely after the reset and the day row's own counter is right.
 */
async function votesSinceMidDayReset(
  db: Executor,
  playerId: number,
  today: Day,
  startAt: Date
): Promise<number | null> {
  if (startAt <= dayStart(today)) return null;
  const counted = await db
    .selectFrom('KnightsVote')
    .select(sql<string>`count(*)`.as('n'))
    .where('playerId', '=', playerId)
    .where('createdAt', '>=', utc(startAt))
    .where('createdAt', '<', utc(nextDayStart(today)))
    .executeTakeFirstOrThrow();
  return Number(counted.n);
}

async function ensureKeeper(trx: Executor, playerId: number, today: Day) {
  const fresh = newPlayerState(today);
  await trx
    .insertInto('KnightsPlayer')
    .values({ playerId, shields: fresh.shields, shieldWeek: dateOf(fresh.shieldWeek) })
    .onConflict((oc) => oc.column('playerId').doNothing())
    .execute();
}

async function completeWatch(
  trx: Executor,
  playerId: number,
  today: Day,
  startAt: Date
): Promise<number> {
  const before = (await readStreakState(trx, playerId, startAt, true)) ?? newPlayerState(today);
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
 * Counts one vote into the player's UTC day: clamps its gold to the rank's daily cap and, on the
 * vote that completes the Watch, advances the streak and prices the bonus. Only votes since `startAt`
 * (the last career reset) count toward the Watch; the cap counts the whole day's gold.
 *
 * Call only after this transaction has locked the player's NewOrderPlayer row: that lock serialises one player's concurrent votes, so the day row cannot be overspent or complete twice.
 */
export async function recordVoteDay(
  trx: Executor,
  {
    playerId,
    rank,
    gold,
    now,
    startAt,
  }: { playerId: number; rank: string; gold: number; now: Date; startAt: Date }
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
  const votes = (await votesSinceMidDayReset(trx, playerId, today, startAt)) ?? row.votes + 1;
  const watchCompleted = !watchStands(row.watchCompletedAt, startAt) && votes >= DAILY.watchSize;
  const bonus = watchCompleted ? await completeWatch(trx, playerId, today, startAt) : 0;

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
  /** Missing today would still leave the streak alive, because a shield will cover it. */
  shieldCoversToday: boolean;
  /** Paid when today's Watch completes; what was paid once it has. */
  bonusGold: number;
};

export async function getDailyStatus(
  db: Executor,
  { playerId, rank, now }: { playerId: number; rank: string; now: Date }
): Promise<DailyStatus> {
  const today = utcDay(now);
  const startAt = await startAtOf(db, playerId);
  const [row, stored, sinceReset] = await Promise.all([
    db
      .selectFrom('KnightsPlayerDay')
      .select(['votes', 'goldRecorded', 'watchCompletedAt', 'bonusGold'])
      .where('playerId', '=', playerId)
      .where('day', '=', dateOf(today))
      .executeTakeFirst(),
    readStreakState(db, playerId, startAt),
    votesSinceMidDayReset(db, playerId, today, startAt),
  ]);
  const state = stored ?? newPlayerState(today);
  const watchDone = watchStands(row?.watchCompletedAt ?? null, startAt);
  const goldCap = dailyGoldCapOf(rank);
  const goldRecorded = row?.goldRecorded ?? 0;

  return {
    votes: sinceReset ?? row?.votes ?? 0,
    watchSize: DAILY.watchSize,
    watchDone,
    goldRecorded,
    goldCap,
    capReached: goldCap > 0 && goldRecorded >= goldCap,
    streak: liveStreak(state, today),
    shields: grantWeeklyShield(state, today).shields,
    maxShields: DAILY.maxShields,
    shieldCoversToday: shieldCoversToday(state, today),
    bonusGold:
      watchDone && row ? row.bonusGold : streakBonusGold(advanceStreak(state, today).streak),
  };
}

export type Recap = {
  day: Day;
  /** "yesterday", "on Oct 26" */
  when: string;
  cast: number;
  confirmed: number;
  /** Settled votes with a verdict; the denominator of `accuracy`. */
  graded: number;
  accuracy: number | null;
  goldEarned: number;
  pending: number;
  /** The Watch bonus paid that day, apart from the vote gold in `goldEarned`. */
  streakBonus: number;
};

/** The player's last play day since their last career reset and before today, unless they dismissed the recap today. */
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

  const startAt = await startAtOf(db, playerId);
  // A day row's counter can hold only votes from before a reset, so look back until a day has votes since it.
  for (let before = today; ; ) {
    const last = await db
      .selectFrom('KnightsPlayerDay')
      .select([sql<string>`"day"::text`.as('day'), 'bonusGold', 'watchCompletedAt'])
      .where('playerId', '=', playerId)
      .where('day', '<', dateOf(before))
      .where('day', '>=', dateOf(utcDay(startAt)))
      .where('votes', '>', 0)
      .orderBy('day', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!last) return null;
    before = last.day;

    const from = new Date(Math.max(dayStart(last.day).getTime(), startAt.getTime()));
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
      .where('createdAt', '>=', utc(from))
      .where('createdAt', '<', utc(nextDayStart(last.day)))
      .executeTakeFirstOrThrow();

    const cast = Number(totals.cast);
    if (cast === 0) continue;
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
      streakBonus: watchStands(last.watchCompletedAt, startAt) ? last.bonusGold : 0,
    };
  }
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
