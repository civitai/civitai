import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { dayStart, utcDay, type Day } from '../daily/days';
import { liveStreak, shieldCoversToday, streakAfterReset } from '../daily/streak';
import { servableItems } from '../queue/queue.service';
import { SMITES } from '../smites/config';
import { stagesWorkedBy } from '../queue/ranks';
import { RANKS } from '../ranks';
import type { SilenceType } from './silence-types';
import { NOTIFY, NOTIFY_KINDS, typeOf, type NotifyKind } from './config';

const dateOf = (day: Day) => sql<Date>`${day}::date`;
const CLAIM_CHUNK = 1000;

export type NotificationBatch = { kind: NotifyKind; type: string; key: string; userIds: number[] };
export type SendBatch = (batch: NotificationBatch) => Promise<void>;

/** Thrown by a sender when the notifications app certainly did not accept the batch, so its claims can be released. */
export class BatchRejected extends Error {
  /** The app is rate limiting this sender, so the rest of the run would be refused too. */
  readonly rateLimited: boolean;

  constructor(message: string, options?: { cause?: unknown; rateLimited?: boolean }) {
    super(message, options);
    this.name = 'BatchRejected';
    this.rateLimited = options?.rateLimited ?? false;
  }
}

export type NotifyResult = {
  sent: Record<NotifyKind, number>;
  /** Players whose batch was refused; their slot was given back. */
  failed: number;
  /** Players whose batch may or may not have been saved; their slot is kept. */
  unconfirmed: number;
  /** A batch had an unknown outcome or the app rate limited the sender, so the run sent nothing further. */
  halted: boolean;
  /** Claims that were sent but could not be marked confirmed, so verdicts may be announced again. */
  confirmFailed: number;
  /** The access flag could not be evaluated, so only moderators were notified. */
  accessUnknown: boolean;
  /** The types to check for "turned everything off" were unavailable, so nothing was sent. */
  skipped: boolean;
};

/**
 * Turning everything off writes a row only for each type that exists then, so judge a player against
 * the types that existed at their latest change (`disabledAt` is when a row was made): silenced means
 * a row for each of them, and at least one row. A type added later never counts against them.
 */
const notSilenced = (silenceTypes: SilenceType[]) => {
  const types = sql.join(silenceTypes.map((t) => sql`${t.type}`));
  const known = sql.join(silenceTypes.map((t) => sql`(${t.type}, ${utc(t.firstSeen)}::timestamp)`));
  const latest = sql`(select max(o."disabledAt") from "UserNotificationSettings" o where o."userId" = pl."userId" and o."type" in (${types}))`;
  return sql<boolean>`not (${latest} is not null and not exists (
    select 1 from (values ${known}) as known("type", "firstSeen")
    where known."firstSeen" <= ${latest}
      and not exists (select 1 from "UserNotificationSettings" r where r."userId" = pl."userId" and r."type" = known."type")
  ))`;
};

/** A player with this many uncleansed smites has a career reset pending and cannot vote (`insertVote`). */
const canPlay = sql<boolean>`(select count(*) from "NewOrderSmite" sm where sm."targetPlayerId" = pl."userId" and sm."cleansedAt" is null) < ${SMITES.max}`;

/**
 * Players who joined the game (they have a `NewOrderPlayer` row), have not turned `kind` off (a settings
 * row means off) and have not been sent anything on `day`.
 */
const recipients = (db: Kysely<DB>, kind: NotifyKind, day: Day, silenceTypes: SilenceType[]) =>
  db
    .selectFrom('NewOrderPlayer as pl')
    .where(
      sql<boolean>`not exists (select 1 from "UserNotificationSettings" o where o."userId" = pl."userId" and o."type" = ${typeOf(
        kind
      )})`
    )
    .where(notSilenced(silenceTypes))
    .where(
      sql<boolean>`not exists (select 1 from "KnightsNotificationSend" n where n."playerId" = pl."userId" and n."day" = ${dateOf(
        day
      )})`
    );

/** A vote cast after a settlement counts as having seen it. */
async function withNewVerdicts(
  db: Kysely<DB>,
  day: Day,
  now: Date,
  silenceTypes: SilenceType[]
): Promise<number[]> {
  const day_ms = 86_400_000;
  const searchFrom = new Date(now.getTime() - NOTIFY.voteSearchDays * day_ms);
  const settledFrom = new Date(now.getTime() - NOTIFY.verdictLookbackDays * day_ms);
  const rows = await recipients(db, 'verdicts', day, silenceTypes)
    .innerJoin('KnightsVote as v', 'v.playerId', 'pl.userId')
    .select('pl.userId')
    .where('v.createdAt', '>=', utc(searchFrom))
    .where('v.settledAt', '>=', utc(settledFrom))
    .where('v.verdict', 'in', ['correct', 'failed'])
    .groupBy('pl.userId')
    .having(
      sql<boolean>`max(v."settledAt") > greatest(
        coalesce((select max(n."confirmedAt") from "KnightsNotificationSend" n where n."playerId" = pl."userId" and n."kind" = ${
          'verdicts' satisfies NotifyKind
        } and n."confirmedAt" is not null), '-infinity'::timestamp),
        coalesce((select max(w."createdAt") from "KnightsVote" w where w."playerId" = pl."userId" and w."createdAt" >= ${utc(
          searchFrom
        )}), '-infinity'::timestamp)
      )`
    )
    .execute();
  return rows.map((r) => r.userId);
}

async function withStreakAtRisk(
  db: Kysely<DB>,
  day: Day,
  silenceTypes: SilenceType[]
): Promise<number[]> {
  const rows = await recipients(db, 'streak', day, silenceTypes)
    .where(canPlay)
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

async function withImagesWaiting(
  db: Kysely<DB>,
  day: Day,
  silenceTypes: SilenceType[]
): Promise<number[]> {
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
    const rows = await recipients(db, 'new-images', day, silenceTypes)
      .where(canPlay)
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
  now: Date,
  silenceTypes: SilenceType[]
): Promise<Record<NotifyKind, number[]>> {
  const day = utcDay(now);
  const warningOpen =
    now >= new Date(dayStart(day).getTime() + NOTIFY.streakWarningHourUtc * 3_600_000);
  const [verdicts, atRisk, waiting] = await Promise.all([
    withNewVerdicts(db, day, now, silenceTypes),
    withStreakAtRisk(db, day, silenceTypes),
    withImagesWaiting(db, day, silenceTypes),
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

/**
 * Marks the claims as accepted by the notifications app, at the time it was sent. Only confirmed
 * claims count as having told the player, and that time is the point later verdicts are compared to.
 * Tried twice: a missed confirmation would announce the same verdicts again tomorrow.
 */
async function confirm(
  db: Kysely<DB>,
  kind: NotifyKind,
  day: Day,
  ids: number[],
  sentAt: Date
): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await db
        .updateTable('KnightsNotificationSend')
        .set({ sentAt: utc(sentAt), confirmedAt: utc(sentAt) })
        .where('day', '=', dateOf(day))
        .where('kind', '=', kind)
        .where('playerId', 'in', ids)
        .execute();
      return true;
    } catch (error) {
      console.error(`knights: could not confirm ${kind} claims (attempt ${attempt})`, error);
    }
  }
  return false;
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
    silenceTypes,
    clock = () => new Date(),
  }: {
    now: Date;
    send: SendBatch;
    /** The ids among those given who can open the app today; `unknown` when the access flag could not be evaluated. */
    accessible: (ids: number[]) => Promise<{ ids: number[]; unknown: boolean }>;
    /**
     * The opt-out types a user who turned everything off has a row for, from the main app. Without
     * it every player would look as if they had not, so an empty list sends nothing.
     */
    silenceTypes: SilenceType[];
    /** When a batch was actually sent; `now` is when the run started. */
    clock?: () => Date;
  }
): Promise<NotifyResult> {
  const day = utcDay(now);
  const result: NotifyResult = {
    sent: { verdicts: 0, streak: 0, 'new-images': 0 },
    failed: 0,
    unconfirmed: 0,
    halted: false,
    confirmFailed: 0,
    skipped: false,
    accessUnknown: false,
  };
  if (silenceTypes.length === 0) {
    console.warn('knights: no notification types to check for silenced players; sending nothing');
    return { ...result, skipped: true };
  }
  const planned = await planNotifications(db, now, silenceTypes);
  const access = await accessible([...new Set(Object.values(planned).flat())]);
  const open = new Set(access.ids);
  result.accessUnknown = access.unknown;
  const plan = Object.fromEntries(
    NOTIFY_KINDS.map(({ kind }) => [
      kind,
      planned[kind].filter((id) => open.has(id)).sort((a, b) => a - b),
    ])
  ) as Record<NotifyKind, number[]>;

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
          try {
            await release(db, kind, day, claimed);
            result.failed += claimed.length;
            if (error.rateLimited) result.halted = true;
          } catch (releaseError) {
            // The slots stay taken, which is the safe side; the database is unwell, so go no further.
            console.error(`knights: could not release ${kind} claims`, releaseError);
            result.unconfirmed += claimed.length;
            result.halted = true;
          }
        } else {
          // Further batches would likely fail the same way, each taking its players' slots.
          result.unconfirmed += claimed.length;
          result.halted = true;
        }
        continue;
      }
      result.sent[kind] += claimed.length;
      if (!(await confirm(db, kind, day, claimed, clock()))) {
        result.confirmFailed += claimed.length;
      }
    }
  }
  return result;
}
