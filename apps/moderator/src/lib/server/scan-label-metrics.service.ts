import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { dbRead, dbWrite } from './db';
import { utcDayStart } from './scan-label.service';
import { BLOCK_MAJORITY, DEFAULT_DAILY_QUOTA, quotaStatus, type QuotaRow } from '$lib/scan-labels';

const DAY_MS = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Per-moderator votes for each UTC day from `fromDay` through `toDay`, inclusive. */
export async function getQuotaReport(
  fromDay: string,
  toDay: string,
  db: Kysely<DB> = dbRead
): Promise<QuotaRow[]> {
  const start = new Date(`${fromDay}T00:00:00.000Z`);
  const end = new Date(new Date(`${toDay}T00:00:00.000Z`).getTime() + DAY_MS);
  const days: string[] = [];
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) days.push(isoDay(new Date(t)));

  const [roster, counts] = await Promise.all([
    db.selectFrom('ScanLabelQuota').select(['userId', 'dailyVotes', 'active']).execute(),
    db
      .selectFrom('ScanLabelVote')
      .select([
        'userId',
        sql<string>`to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.as('day'),
        (eb) => eb.fn.countAll<string>().as('n'),
      ])
      .where('createdAt', '>=', start)
      .where('createdAt', '<', end)
      .groupBy(['userId', 'day'])
      .execute(),
  ]);

  const quotaOf = new Map(roster.map((r) => [r.userId, r]));
  const votesOf = new Map<number, Map<string, number>>();
  for (const c of counts) {
    if (!votesOf.has(c.userId)) votesOf.set(c.userId, new Map());
    votesOf.get(c.userId)!.set(c.day, Number(c.n));
  }
  const userIds = [
    ...new Set([...roster.filter((r) => r.active).map((r) => r.userId), ...votesOf.keys()]),
  ];
  const names = userIds.length
    ? await db.selectFrom('User').select(['id', 'username']).where('id', 'in', userIds).execute()
    : [];
  const nameOf = new Map(names.map((n) => [n.id, n.username]));

  return userIds
    .map((userId): QuotaRow => {
      const q = quotaOf.get(userId);
      const quota = q?.dailyVotes ?? DEFAULT_DAILY_QUOTA;
      const onRoster = !!q?.active;
      return {
        userId,
        username: nameOf.get(userId) ?? null,
        quota,
        onRoster,
        days: days.map((day) => {
          const votes = votesOf.get(userId)?.get(day) ?? 0;
          return { day, votes, status: quotaStatus(votes, quota, onRoster) };
        }),
      };
    })
    .sort((a, b) => (a.username ?? '').localeCompare(b.username ?? ''));
}

export type DailyTotals = {
  day: string;
  flagged: number;
  votes: number;
  decided: number;
  blocked: number;
};

export async function getDailyTotals(
  days: number,
  now: Date = new Date(),
  db: Kysely<DB> = dbRead
): Promise<DailyTotals[]> {
  const start = new Date(utcDayStart(now).getTime() - (days - 1) * DAY_MS);
  const dayOf = (col: string) =>
    sql<string>`to_char(${sql.ref(col)} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const [flagged, votes, decided] = await Promise.all([
    db
      .selectFrom('ScanLabelItem')
      .select([dayOf('firstFlaggedAt').as('day'), (eb) => eb.fn.countAll<string>().as('n')])
      .where('firstFlaggedAt', '>=', start)
      .groupBy('day')
      .execute(),
    db
      .selectFrom('ScanLabelVote')
      .select([dayOf('createdAt').as('day'), (eb) => eb.fn.countAll<string>().as('n')])
      .where('createdAt', '>=', start)
      .groupBy('day')
      .execute(),
    db
      .selectFrom('ScanLabelItem')
      .select([
        dayOf('decidedAt').as('day'),
        (eb) => eb.fn.countAll<string>().as('n'),
        sql<string>`count(*) FILTER (WHERE "outcome" = 'block')`.as('blocked'),
      ])
      .where('decidedAt', '>=', start)
      .groupBy('day')
      .execute(),
  ]);
  const by = <T extends { day: string }>(rows: T[]) => new Map(rows.map((r) => [r.day, r]));
  const f = by(flagged);
  const v = by(votes);
  const d = by(decided);
  return Array.from({ length: days }, (_, i) => {
    const day = isoDay(new Date(start.getTime() + i * DAY_MS));
    return {
      day,
      flagged: Number(f.get(day)?.n ?? 0),
      votes: Number(v.get(day)?.n ?? 0),
      decided: Number(d.get(day)?.n ?? 0),
      blocked: Number(d.get(day)?.blocked ?? 0),
    };
  }).reverse();
}

export type VersionStats = {
  flaggerVersion: string;
  decided: number;
  majorityBlock: number;
  unanimousBlock: number;
  unanimousClear: number;
};

/** Decided items per flagger version. An item flagged by two versions counts under both. */
export async function getVersionStats(db: Kysely<DB> = dbRead): Promise<VersionStats[]> {
  const rows = await db
    .selectFrom('ScanLabelItem as i')
    .innerJoin(
      (eb) =>
        eb.selectFrom('ScanLabelFlag').select(['itemId', 'flaggerVersion']).distinct().as('f'),
      (join) => join.onRef('f.itemId', '=', 'i.id')
    )
    .select([
      'f.flaggerVersion',
      (eb) => eb.fn.countAll<string>().as('decided'),
      sql<string>`count(*) FILTER (WHERE i."outcome" = 'block')`.as('majorityBlock'),
      sql<string>`count(*) FILTER (WHERE i."outcome" = 'block' AND i."unanimous")`.as(
        'unanimousBlock'
      ),
      sql<string>`count(*) FILTER (WHERE i."outcome" = 'clear' AND i."unanimous")`.as(
        'unanimousClear'
      ),
    ])
    .where('i.status', '=', 'decided')
    .groupBy('f.flaggerVersion')
    .orderBy('f.flaggerVersion', 'desc')
    .execute();
  return rows.map((r) => ({
    flaggerVersion: r.flaggerVersion,
    decided: Number(r.decided),
    majorityBlock: Number(r.majorityBlock),
    unanimousBlock: Number(r.unanimousBlock),
    unanimousClear: Number(r.unanimousClear),
  }));
}

export type ModeratorStats = {
  userId: number;
  username: string | null;
  votes: number;
  /** Share of this moderator's votes on decided items that matched the final outcome. */
  agreement: number | null;
  medianMs: number | null;
};

export async function getModeratorStats(
  sinceDays: number,
  now: Date = new Date(),
  db: Kysely<DB> = dbRead
): Promise<ModeratorStats[]> {
  const since = new Date(utcDayStart(now).getTime() - (sinceDays - 1) * DAY_MS);
  const rows = await db
    .selectFrom('ScanLabelVote as v')
    .innerJoin('ScanLabelItem as i', 'i.id', 'v.itemId')
    .leftJoin('User as u', 'u.id', 'v.userId')
    .select([
      'v.userId',
      'u.username',
      (eb) => eb.fn.countAll<string>().as('votes'),
      sql<string>`count(*) FILTER (WHERE i."status" = 'decided')`.as('decided'),
      sql<string>`count(*) FILTER (WHERE i."status" = 'decided' AND v."block" = (i."outcome" = 'block'))`.as(
        'agreed'
      ),
      sql<number | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY v."msOnItem")`.as('medianMs'),
    ])
    .where('v.createdAt', '>=', since)
    .groupBy(['v.userId', 'u.username'])
    .orderBy('votes', 'desc')
    .execute();
  return rows.map((r) => ({
    userId: r.userId,
    username: r.username,
    votes: Number(r.votes),
    agreement: Number(r.decided) ? Number(r.agreed) / Number(r.decided) : null,
    medianMs: r.medianMs == null ? null : Math.round(Number(r.medianMs)),
  }));
}

export async function getActionHealth(db: Kysely<DB> = dbRead) {
  const row = await db
    .selectFrom('ScanLabelItem')
    .select([
      sql<string>`count(*) FILTER (WHERE "actionedAt" IS NOT NULL)`.as('blocked'),
      sql<string>`count(*) FILTER (WHERE "blockVotes" >= ${BLOCK_MAJORITY} AND "actionedAt" IS NULL)`.as(
        'pending'
      ),
      sql<string>`count(*) FILTER (WHERE "actionError" IS NOT NULL)`.as('failing'),
    ])
    .executeTakeFirstOrThrow();
  return {
    blocked: Number(row.blocked),
    pending: Number(row.pending),
    failing: Number(row.failing),
  };
}

/** Insert or update a moderator's quota. False when the user does not exist. */
export async function setQuota({
  userId,
  dailyVotes,
  active,
  updatedBy,
}: {
  userId: number;
  dailyVotes: number;
  active: boolean;
  updatedBy: number;
}): Promise<boolean> {
  const user = await dbWrite
    .selectFrom('User')
    .select('id')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) return false;
  const now = new Date();
  const res = await dbWrite
    .insertInto('ScanLabelQuota')
    .values({ userId, dailyVotes, active, updatedBy, updatedAt: now })
    .onConflict((oc) =>
      oc.column('userId').doUpdateSet({ dailyVotes, active, updatedBy, updatedAt: now })
    )
    .executeTakeFirst();
  return !!res.numInsertedOrUpdatedRows;
}
