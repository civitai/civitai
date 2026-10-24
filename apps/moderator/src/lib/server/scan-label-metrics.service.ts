import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { createSessionClient } from '@civitai/auth';
import { dbRead, dbWrite } from './db';
import { logAxiomError, logToAxiom } from './axiom';
import {
  BLOCK_MAJORITY,
  DAY_MS,
  dayBounds,
  dayRange,
  effectiveQuota,
  isoDay,
  quotaStatus,
  utcDayStart,
  type QuotaRow,
} from '$lib/scan-labels';

export async function getQuotaReport(
  lastDay: string,
  dayCount: number,
  now: Date = new Date(),
  db: Kysely<DB> = dbRead
): Promise<QuotaRow[]> {
  const days = dayRange(lastDay, dayCount);
  const start = dayBounds(days[0]).start;
  const end = dayBounds(lastDay).end;
  const today = isoDay(now);

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
      const quota = effectiveQuota(q);
      const onRoster = !!q?.active;
      return {
        userId,
        username: nameOf.get(userId) ?? null,
        quota,
        onRoster,
        days: days.map((day) => {
          const votes = votesOf.get(userId)?.get(day) ?? 0;
          return { day, votes, status: quotaStatus(votes, quota, onRoster, day < today) };
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
      sql<string>`count(*) FILTER (WHERE "actionResult" = 'blocked' AND "actionedAt" IS NOT NULL)`.as(
        'blocked'
      ),
      sql<string>`count(*) FILTER (WHERE "actionResult" IN ('already-blocked', 'image-missing'))`.as(
        'skipped'
      ),
      sql<string>`count(*) FILTER (WHERE "blockVotes" >= ${BLOCK_MAJORITY} AND "actionedAt" IS NULL AND "status" <> 'void')`.as(
        'pending'
      ),
      sql<string>`count(*) FILTER (WHERE "actionedAt" IS NULL AND "actionError" IS NOT NULL AND "status" <> 'void')`.as(
        'failing'
      ),
    ])
    .executeTakeFirstOrThrow();
  return {
    blocked: Number(row.blocked),
    skipped: Number(row.skipped),
    pending: Number(row.pending),
    failing: Number(row.failing),
  };
}

/** The role that opens /images/scan-labels. Being on the roster is what grants it. */
export const SCAN_LABEL_ROLE = 'moderator:scan-labels';
const ROSTER_NOTE = 'Scan Labels roster';

export type RosterDeps = {
  /** Busts the member's cached session so the role change reaches their next request. */
  invalidateSession: (userId: number) => Promise<void>;
};

let sessions: ReturnType<typeof createSessionClient> | undefined;
const defaultDeps: RosterDeps = {
  invalidateSession: (userId) => (sessions ??= createSessionClient()).invalidate(userId),
};

export type RosterResult =
  | { ok: true; username: string | null; sessionBusted: boolean }
  | { ok: false; reason: 'no-user' | 'not-moderator' | 'not-on-roster' | 'no-role' };

/**
 * Puts a user on the roster (or takes them off) and grants or revokes `SCAN_LABEL_ROLE` in the same
 * transaction. The app's front gate admits only `User.isModerator`, so adding anyone else would grant a
 * role that opens nothing.
 */
export async function setQuota(
  {
    userId,
    dailyVotes,
    active,
    updatedBy,
  }: { userId: number; dailyVotes: number; active: boolean; updatedBy: number },
  deps: RosterDeps = defaultDeps
): Promise<RosterResult> {
  const result = await dbWrite.transaction().execute(async (trx): Promise<RosterResult> => {
    const user = await trx
      .selectFrom('User')
      .select(['id', 'username', 'isModerator'])
      .where('id', '=', userId)
      .executeTakeFirst();
    if (!user) return { ok: false, reason: 'no-user' };
    if (active && !user.isModerator) return { ok: false, reason: 'not-moderator' };
    // `UserRole.role` references `Role`, which the auth hub owns; without the row the grant would throw.
    if (active) {
      const role = await trx
        .selectFrom('Role')
        .select('id')
        .where('id', '=', SCAN_LABEL_ROLE)
        .executeTakeFirst();
      if (!role) return { ok: false, reason: 'no-role' };
    }
    const now = new Date();
    await trx
      .insertInto('ScanLabelQuota')
      .values({ userId, dailyVotes, active, updatedBy, updatedAt: now })
      .onConflict((oc) =>
        oc.column('userId').doUpdateSet({ dailyVotes, active, updatedBy, updatedAt: now })
      )
      .execute();
    await syncRole(trx, userId, active, updatedBy);
    return { ok: true, username: user.username, sessionBusted: false };
  });
  return result.ok ? { ...result, sessionBusted: await bustSession(userId, deps) } : result;
}

/** Takes a user off the roster, keeping their quota for when they return. */
export async function removeFromRoster(
  { userId, updatedBy }: { userId: number; updatedBy: number },
  deps: RosterDeps = defaultDeps
): Promise<RosterResult> {
  const result = await dbWrite.transaction().execute(async (trx): Promise<RosterResult> => {
    const row = await trx
      .updateTable('ScanLabelQuota')
      .set({ active: false, updatedBy, updatedAt: new Date() })
      .where('userId', '=', userId)
      .returning('userId')
      .executeTakeFirst();
    if (!row) return { ok: false, reason: 'not-on-roster' };
    await syncRole(trx, userId, false, updatedBy);
    const user = await trx
      .selectFrom('User')
      .select('username')
      .where('id', '=', userId)
      .executeTakeFirst();
    return { ok: true, username: user?.username ?? null, sessionBusted: false };
  });
  return result.ok ? { ...result, sessionBusted: await bustSession(userId, deps) } : result;
}

async function syncRole(trx: Kysely<DB>, userId: number, active: boolean, actor: number) {
  if (active) {
    await trx
      .insertInto('UserRole')
      .values({ userId, role: SCAN_LABEL_ROLE, note: ROSTER_NOTE, addedById: actor })
      .onConflict((oc) => oc.columns(['userId', 'role']).doNothing())
      .execute();
    return;
  }
  // The role exists only for this page, so it goes even when someone granted it from the auth hub.
  const removed = await trx
    .deleteFrom('UserRole')
    .where('userId', '=', userId)
    .where('role', '=', SCAN_LABEL_ROLE)
    .returning(['note', 'addedById'])
    .executeTakeFirst();
  if (removed && removed.note !== ROSTER_NOTE)
    void logToAxiom({
      type: 'info',
      event: 'scan label role revoked from a grant made elsewhere',
      userId,
      actor,
      note: removed.note,
      addedById: removed.addedById,
    }).catch(() => {});
}

// After commit, never inside the transaction. A failed bust leaves the write in place: the change then
// lands when the cached session expires.
async function bustSession(userId: number, deps: RosterDeps): Promise<boolean> {
  try {
    await deps.invalidateSession(userId);
    return true;
  } catch (error) {
    void logAxiomError(error, { event: 'scan label roster session bust failed', userId });
    return false;
  }
}
