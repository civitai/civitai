import { sql, type Kysely } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { dayStart, utcDay, type Day } from '../daily/days';
import { liveStreak, shieldCoversToday, streakAfterReset } from '../daily/streak';
import { servableItems } from '../queue/queue.service';
import { stagesWorkedBy } from '../queue/ranks';
import { RANKS } from '../ranks';
import { NOTIFY, NOTIFY_KINDS, typeOf, type NotifyKind } from './config';

const dateOf = (day: Day) => sql<Date>`${day}::date`;
const CLAIM_CHUNK = 1000;

/** One bulk notification: the same message for every user in it. */
export type NotificationBatch = { kind: NotifyKind; type: string; key: string; userIds: number[] };
export type SendBatch = (batch: NotificationBatch) => Promise<void>;

export type NotifyResult = { sent: Record<NotifyKind, number>; failed: number };

/** Players who opted into `kind` and have not been sent anything on `day`. */
const subscribers = (db: Kysely<DB>, kind: NotifyKind, day: Day) =>
  db
    .selectFrom('UserNotificationSettings as s')
    .where('s.type', '=', typeOf(kind))
    .where(
      sql<boolean>`not exists (select 1 from "KnightsNotificationSend" n where n."playerId" = s."userId" and n."day" = ${dateOf(
        day
      )})`
    );

/**
 * Subscribers whose votes settled since they last played and since they were last told about verdicts.
 * "Played" is the player's newest vote: any vote after a settlement means they have seen it.
 */
async function withNewVerdicts(db: Kysely<DB>, day: Day, now: Date): Promise<number[]> {
  const day_ms = 86_400_000;
  const searchFrom = new Date(now.getTime() - NOTIFY.voteSearchDays * day_ms);
  const settledFrom = new Date(now.getTime() - NOTIFY.verdictLookbackDays * day_ms);
  const rows = await subscribers(db, 'verdicts', day)
    .innerJoin('KnightsVote as v', 'v.playerId', 's.userId')
    .select('s.userId')
    .where('v.createdAt', '>=', utc(searchFrom))
    .where('v.settledAt', '>=', utc(settledFrom))
    .where('v.verdict', 'in', ['correct', 'failed'])
    .groupBy('s.userId')
    .having(
      sql<boolean>`max(v."settledAt") > greatest(
        coalesce((select max(n."sentAt") from "KnightsNotificationSend" n where n."playerId" = s."userId" and n."type" = ${typeOf(
          'verdicts'
        )}), '-infinity'::timestamp),
        coalesce((select max(w."createdAt") from "KnightsVote" w where w."playerId" = s."userId" and w."createdAt" >= ${utc(
          searchFrom
        )}), '-infinity'::timestamp)
      )`
    )
    .execute();
  return rows.map((r) => r.userId);
}

/** Subscribers with a live streak, no Watch yet today, and no shield that would cover the miss. */
async function withStreakAtRisk(db: Kysely<DB>, day: Day): Promise<number[]> {
  const rows = await subscribers(db, 'streak', day)
    .innerJoin('KnightsPlayer as k', 'k.playerId', 's.userId')
    .innerJoin('NewOrderPlayer as p', 'p.userId', 's.userId')
    .leftJoin('KnightsPlayerDay as d', (join) =>
      join.onRef('d.playerId', '=', 'k.playerId').onRef('d.day', '=', 'k.lastWatchDay')
    )
    .select([
      's.userId',
      'k.streak',
      'k.shields',
      sql<string>`k."lastWatchDay"::text`.as('lastWatchDay'),
      sql<string>`k."shieldWeek"::text`.as('shieldWeek'),
      'p.startAt',
      'd.watchCompletedAt',
    ])
    .where('k.streak', '>', 0)
    .where('k.lastWatchDay', '<', dateOf(day))
    .execute();

  return rows
    .filter((row) => {
      const state = streakAfterReset(
        {
          streak: row.streak,
          shields: row.shields,
          lastWatchDay: row.lastWatchDay,
          shieldWeek: row.shieldWeek,
        },
        row.startAt,
        row.watchCompletedAt
      );
      return liveStreak(state, day) > 0 && !shieldCoversToday(state, day);
    })
    .map((row) => row.userId);
}

/** Subscribers of a voting rank for whom the queue holds an item they have not voted on. */
async function withImagesWaiting(db: Kysely<DB>, day: Day): Promise<number[]> {
  const found: number[] = [];
  for (const rank of RANKS) {
    const stages = stagesWorkedBy(rank);
    if (rank === 'Acolyte' || rank === 'Inquisitor' || stages.length === 0) continue;
    const rows = await subscribers(db, 'new-images', day)
      .innerJoin('NewOrderPlayer as p', 'p.userId', 's.userId')
      .select('s.userId')
      .where('p.rankType', '=', rank)
      .where((eb) =>
        eb.exists(
          servableItems(db)
            .select(sql<number>`1`.as('one'))
            .where('i.minRank', 'in', stages)
            .where(
              sql<boolean>`not exists (select 1 from "KnightsVote" v where v."itemId" = i."id" and v."playerId" = s."userId")`
            )
        )
      )
      .execute();
    found.push(...rows.map((r) => r.userId));
  }
  return found;
}

/**
 * Picks at most one notification per player for the UTC day of `now`: verdicts, then a streak
 * warning (from `streakWarningHourUtc`), then new images. Until the warning hour a player whose
 * streak is at risk is held back from "new images", so the warning still has the day's slot.
 */
export async function planNotifications(
  db: Kysely<DB>,
  now: Date
): Promise<Record<NotifyKind, number[]>> {
  const day = utcDay(now);
  const warningOpen =
    now >= new Date(dayStart(day).getTime() + NOTIFY.streakWarningHourUtc * 3_600_000);
  const [verdicts, atRisk, waiting] = await Promise.all([
    withNewVerdicts(db, day, now),
    withStreakAtRisk(db, day),
    withImagesWaiting(db, day),
  ]);

  const plan: Record<NotifyKind, number[]> = { verdicts, streak: [], 'new-images': [] };
  const chosen = new Set(verdicts);
  if (warningOpen) {
    plan.streak = atRisk.filter((id) => !chosen.has(id));
    for (const id of plan.streak) chosen.add(id);
  }
  const held = new Set(warningOpen ? [] : atRisk);
  plan['new-images'] = waiting.filter((id) => !chosen.has(id) && !held.has(id));
  return plan;
}

/** The send claim is the day's one slot: whoever inserts it sends, a rerun finds it taken. */
async function claim(db: Kysely<DB>, kind: NotifyKind, day: Day, ids: number[]): Promise<number[]> {
  const rows = await db
    .insertInto('KnightsNotificationSend')
    .values(ids.map((playerId) => ({ playerId, day: dateOf(day), type: kind })))
    .onConflict((oc) => oc.columns(['playerId', 'day']).doNothing())
    .returning('playerId')
    .execute();
  return rows.map((r) => r.playerId);
}

const release = (db: Kysely<DB>, kind: NotifyKind, day: Day, ids: number[]) =>
  db
    .deleteFrom('KnightsNotificationSend')
    .where('day', '=', dateOf(day))
    .where('type', '=', kind)
    .where('playerId', 'in', ids)
    .execute();

/** Plans, claims each player's slot, then sends. A batch that fails to send gives its slots back so the next run retries it. */
export async function sendNotifications(
  db: Kysely<DB>,
  { now, send }: { now: Date; send: SendBatch }
): Promise<NotifyResult> {
  const day = utcDay(now);
  const plan = await planNotifications(db, now);
  const result: NotifyResult = {
    sent: { verdicts: 0, streak: 0, 'new-images': 0 },
    failed: 0,
  };

  for (const { kind } of NOTIFY_KINDS) {
    const ids = plan[kind];
    for (let at = 0; at < ids.length; at += CLAIM_CHUNK) {
      const claimed = await claim(db, kind, day, ids.slice(at, at + CLAIM_CHUNK));
      if (claimed.length === 0) continue;
      const batch: NotificationBatch = {
        kind,
        type: typeOf(kind),
        key: `knights-daily:${kind}:${day}:${now.getTime()}:${at}`,
        userIds: claimed,
      };
      try {
        await send(batch);
        result.sent[kind] += claimed.length;
      } catch (error) {
        console.error(`knights: ${kind} notification batch failed`, error);
        result.failed += claimed.length;
        await release(db, kind, day, claimed);
      }
    }
  }
  return result;
}
