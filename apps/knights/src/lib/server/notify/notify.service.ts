import { createHash } from 'node:crypto';
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
/** What `claim` stores in `KnightsNotificationSend.type`: the kind, not the notification type. */
const VERDICTS_KIND: NotifyKind = 'verdicts';

export type NotificationBatch = { kind: NotifyKind; type: string; key: string; userIds: number[] };
export type SendBatch = (batch: NotificationBatch) => Promise<void>;

/** Thrown by a sender when the notifications app certainly did not accept the batch, so its claims can be released. */
export class BatchRejected extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BatchRejected';
  }
}

export type NotifyResult = {
  sent: Record<NotifyKind, number>;
  /** Players whose batch was refused; their slot was given back. */
  failed: number;
  /** Players whose batch may or may not have been saved; their slot is kept. */
  unconfirmed: number;
  /** A batch had an unknown outcome, so the run sent nothing further. */
  halted: boolean;
};

/**
 * Players who joined the game (they have a `NewOrderPlayer` row), have not turned `kind` off (a settings
 * row means off) and have not been sent anything on `day`.
 */
const recipients = (db: Kysely<DB>, kind: NotifyKind, day: Day) =>
  db
    .selectFrom('NewOrderPlayer as pl')
    .where(
      sql<boolean>`not exists (select 1 from "UserNotificationSettings" o where o."userId" = pl."userId" and o."type" = ${typeOf(
        kind
      )})`
    )
    .where(
      sql<boolean>`not exists (select 1 from "KnightsNotificationSend" n where n."playerId" = pl."userId" and n."day" = ${dateOf(
        day
      )})`
    );

/** A vote cast after a settlement counts as having seen it. */
async function withNewVerdicts(db: Kysely<DB>, day: Day, now: Date): Promise<number[]> {
  const day_ms = 86_400_000;
  const searchFrom = new Date(now.getTime() - NOTIFY.voteSearchDays * day_ms);
  const settledFrom = new Date(now.getTime() - NOTIFY.verdictLookbackDays * day_ms);
  const rows = await recipients(db, 'verdicts', day)
    .innerJoin('KnightsVote as v', 'v.playerId', 'pl.userId')
    .select('pl.userId')
    .where('v.createdAt', '>=', utc(searchFrom))
    .where('v.settledAt', '>=', utc(settledFrom))
    .where('v.verdict', 'in', ['correct', 'failed'])
    .groupBy('pl.userId')
    .having(
      sql<boolean>`max(v."settledAt") > greatest(
        coalesce((select max(n."sentAt") from "KnightsNotificationSend" n where n."playerId" = pl."userId" and n."kind" = ${VERDICTS_KIND} and n."confirmedAt" is not null), '-infinity'::timestamp),
        coalesce((select max(w."createdAt") from "KnightsVote" w where w."playerId" = pl."userId" and w."createdAt" >= ${utc(
          searchFrom
        )}), '-infinity'::timestamp)
      )`
    )
    .execute();
  return rows.map((r) => r.userId);
}

async function withStreakAtRisk(db: Kysely<DB>, day: Day): Promise<number[]> {
  const rows = await recipients(db, 'streak', day)
    .innerJoin('KnightsPlayer as k', 'k.playerId', 'pl.userId')
    .leftJoin('KnightsPlayerDay as d', (join) =>
      join.onRef('d.playerId', '=', 'k.playerId').onRef('d.day', '=', 'k.lastWatchDay')
    )
    .select([
      'pl.userId',
      'k.streak',
      'k.shields',
      sql<string>`k."lastWatchDay"::text`.as('lastWatchDay'),
      sql<string>`k."shieldWeek"::text`.as('shieldWeek'),
      'pl.startAt',
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

async function withImagesWaiting(db: Kysely<DB>, day: Day): Promise<number[]> {
  // A vote cannot predate its item, so no open item has votes before the oldest one; the constant
  // bound on the partition key lets Postgres skip older monthly partitions (a bound that references
  // the item's own createdAt does not prune).
  const oldest = await db
    .selectFrom('KnightsQueueItem')
    .select((eb) => eb.fn.min('createdAt').as('at'))
    .where('status', '=', 'Open')
    .executeTakeFirst();
  if (!oldest?.at) return [];
  const oldestOpen = oldest.at;
  const found: number[] = [];
  for (const rank of RANKS) {
    const stages = stagesWorkedBy(rank);
    // Same rule as `canVote`: these ranks work no stage. Spelled out so `rank` narrows to the column's type.
    if (rank === 'Acolyte' || rank === 'Inquisitor' || stages.length === 0) continue;
    const rows = await recipients(db, 'new-images', day)
      .select('pl.userId')
      .where('pl.rankType', '=', rank)
      .where((eb) =>
        eb.exists(
          servableItems(db)
            .select(sql<number>`1`.as('one'))
            .where('i.minRank', 'in', stages)
            .where(
              sql<boolean>`not exists (select 1 from "KnightsVote" v where v."itemId" = i."id" and v."playerId" = pl."userId" and v."createdAt" >= ${utc(
                oldestOpen
              )})`
            )
        )
      )
      .execute();
    found.push(...rows.map((r) => r.userId));
  }
  return found;
}

/**
 * At most one per player per UTC day: verdicts, then streak (from `streakWarningHourUtc`), then new
 * images. Before that hour an at-risk player is held back from new images so the warning keeps the slot.
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

/** Insert-first is the dedupe: concurrent or repeated runs cannot both send to a player. */
async function claim(
  db: Kysely<DB>,
  kind: NotifyKind,
  day: Day,
  ids: number[],
  now: Date
): Promise<number[]> {
  const rows = await db
    .insertInto('KnightsNotificationSend')
    .values(ids.map((playerId) => ({ playerId, day: dateOf(day), kind, sentAt: utc(now) })))
    .onConflict((oc) => oc.columns(['playerId', 'day']).doNothing())
    .returning('playerId')
    .execute();
  return rows.map((r) => r.playerId);
}

const release = (db: Kysely<DB>, kind: NotifyKind, day: Day, ids: number[]) =>
  db
    .deleteFrom('KnightsNotificationSend')
    .where('day', '=', dateOf(day))
    .where('kind', '=', kind)
    .where('playerId', 'in', ids)
    .execute();

/** Marks the claims as accepted by the notifications app; only confirmed claims count as having told the player. */
async function confirm(db: Kysely<DB>, kind: NotifyKind, day: Day, ids: number[], now: Date) {
  try {
    await db
      .updateTable('KnightsNotificationSend')
      .set({ confirmedAt: utc(now) })
      .where('day', '=', dateOf(day))
      .where('kind', '=', kind)
      .where('playerId', 'in', ids)
      .execute();
  } catch (error) {
    console.error(`knights: could not confirm ${kind} claims`, error);
  }
}

/** The same chunk of players always gets the same key, so a retry of it can be recognised server-side. */
const batchKey = (kind: NotifyKind, day: Day, userIds: number[]) =>
  `knights-daily:${kind}:${day}:${createHash('sha1').update(userIds.join(',')).digest('hex')}`;

/**
 * Plans, claims each player's slot, then sends. A refused batch gives its slots back for the next run.
 * One whose outcome is unknown (a timeout, a transport error, a 5xx, any error not known to precede the
 * send) keeps them, because a retry could send a second notification that day, and ends the run.
 */
export async function sendNotifications(
  db: Kysely<DB>,
  {
    now,
    send,
    accessible,
  }: {
    now: Date;
    send: SendBatch;
    /** The ids among those given who can open the app today. */
    accessible: (ids: number[]) => Promise<number[]>;
  }
): Promise<NotifyResult> {
  const day = utcDay(now);
  const planned = await planNotifications(db, now);
  const open = new Set(await accessible([...new Set(Object.values(planned).flat())]));
  const plan = Object.fromEntries(
    NOTIFY_KINDS.map(({ kind }) => [
      kind,
      planned[kind].filter((id) => open.has(id)).sort((a, b) => a - b),
    ])
  ) as Record<NotifyKind, number[]>;
  const result: NotifyResult = {
    sent: { verdicts: 0, streak: 0, 'new-images': 0 },
    failed: 0,
    unconfirmed: 0,
    halted: false,
  };

  for (const { kind } of NOTIFY_KINDS) {
    const ids = plan[kind];
    for (let at = 0; at < ids.length && !result.halted; at += CLAIM_CHUNK) {
      const claimed = await claim(db, kind, day, ids.slice(at, at + CLAIM_CHUNK), now);
      if (claimed.length === 0) continue;
      claimed.sort((a, b) => a - b);
      const batch: NotificationBatch = {
        kind,
        type: typeOf(kind),
        key: batchKey(kind, day, claimed),
        userIds: claimed,
      };
      try {
        await send(batch);
      } catch (error) {
        console.error(`knights: ${kind} notification batch failed`, error);
        if (error instanceof BatchRejected) {
          result.failed += claimed.length;
          await release(db, kind, day, claimed);
        } else {
          // Further batches would likely fail the same way, each taking its players' slots.
          result.unconfirmed += claimed.length;
          result.halted = true;
        }
        continue;
      }
      result.sent[kind] += claimed.length;
      await confirm(db, kind, day, claimed, now);
    }
  }
  return result;
}
