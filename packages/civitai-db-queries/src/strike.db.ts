import { sql } from 'kysely';
import type { Kysely, Selectable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { jsonObjectFrom, toJson } from './infra/helpers';

// Column enums derived from the schema (Selectable unwraps the Generated<> wrappers) so this module needs no
// app-side enum import.
type StrikeStatusValue = Selectable<DB['UserStrike']>['status'];
type StrikeReasonValue = Selectable<DB['UserStrike']>['reason'];
type EntityTypeValue = NonNullable<Selectable<DB['UserStrike']>['entityType']>;

export type UserStrikeRow = Selectable<DB['UserStrike']>;

// Only the strike-relevant slice of the User.meta jsonb this module reads/writes; other keys are preserved on
// merge via `...currentMeta`.
type UserMeta = {
  strikeFlaggedForReview?: boolean;
  strikeFlaggedAt?: Date | string;
  [key: string]: unknown;
};

// ============================================================================
// Rate limiting / point reads
// ============================================================================

// Whether a non-manual auto-strike should be skipped: true once the user already has >= 1 non-manual strike
// created today.
export async function shouldRateLimitStrike(db: Kysely<DB>, userId: number): Promise<boolean> {
  const result = await sql<{ count: string }>`
    SELECT COUNT(*) as count
    FROM "UserStrike"
    WHERE "userId" = ${userId}
      AND "createdAt" >= CURRENT_DATE
      AND "reason" != ${'ManualModAction'}::"StrikeReason"
  `.execute(db);
  return Number(result.rows[0]?.count ?? 0) >= 1;
}

// Sum of a user's currently-active (non-expired) strike points.
export async function getActiveStrikePoints(db: Kysely<DB>, userId: number): Promise<number> {
  const result = await sql<{ sum: string | null }>`
    SELECT SUM(points) as sum
    FROM "UserStrike"
    WHERE "userId" = ${userId}
      AND "status" = ${'Active'}::"StrikeStatus"
      AND "expiresAt" > NOW()
  `.execute(db);
  return Number(result.rows[0]?.sum ?? 0);
}

// Lightweight summary (count / summed points / soonest expiry) of a user's active strikes, in one query.
export async function getStrikeSummary(db: Kysely<DB>, userId: number) {
  const result = await sql<{ count: string; sum: string | null; next_expiry: Date | null }>`
    SELECT
      COUNT(*) as count,
      SUM(points) as sum,
      MIN("expiresAt") as next_expiry
    FROM "UserStrike"
    WHERE "userId" = ${userId}
      AND "status" = ${'Active'}::"StrikeStatus"
      AND "expiresAt" > NOW()
  `.execute(db);

  const row = result.rows[0];
  return {
    activeStrikes: Number(row?.count ?? 0),
    totalActivePoints: Number(row?.sum ?? 0),
    nextExpiry: row?.next_expiry ?? null,
  };
}

// Same active-points sum as getActiveStrikePoints, but takes a row lock (`FOR UPDATE`) so the escalation
// transaction reads-then-writes without a racing strike changing the total underneath it. Must run on a `trx`.
// The lock is taken in the subquery (Postgres rejects `FOR UPDATE` alongside an aggregate — the original
// service's `SELECT SUM(...) ... FOR UPDATE` was invalid SQL); the outer query sums the locked rows.
export async function getActiveStrikePointsForUpdate(
  db: Kysely<DB>,
  userId: number
): Promise<number> {
  const result = await sql<{ sum: string | null }>`
    SELECT COALESCE(SUM(points), 0) as sum
    FROM (
      SELECT points
      FROM "UserStrike"
      WHERE "userId" = ${userId}
        AND "status" = ${'Active'}::"StrikeStatus"
        AND "expiresAt" > NOW()
      FOR UPDATE
    ) locked
  `.execute(db);
  return Number(result.rows[0]?.sum ?? 0);
}

// ============================================================================
// Strike lists
// ============================================================================

// A user's strikes (newest first) plus the active-points aggregate the strike UI shows. `includeExpired`
// widens past Active; `includeInternalNotes` is mod-only — users must never receive the internal notes column.
export async function getStrikesForUser(
  db: Kysely<DB>,
  input: { userId: number; includeExpired?: boolean; includeInternalNotes?: boolean }
) {
  const { userId, includeExpired = false, includeInternalNotes = false } = input;

  const [strikes, aggregate] = await Promise.all([
    db
      .selectFrom('UserStrike')
      .select((eb) => [
        'UserStrike.id',
        'UserStrike.userId',
        'UserStrike.reason',
        'UserStrike.status',
        'UserStrike.points',
        'UserStrike.description',
        'UserStrike.entityType',
        'UserStrike.entityId',
        'UserStrike.reportId',
        'UserStrike.createdAt',
        'UserStrike.expiresAt',
        'UserStrike.voidedAt',
        'UserStrike.voidedBy',
        'UserStrike.voidReason',
        'UserStrike.issuedBy',
        jsonObjectFrom(
          eb
            .selectFrom('User as iu')
            .select(['iu.id', 'iu.username'])
            .whereRef('iu.id', '=', 'UserStrike.issuedBy')
        ).as('issuedByUser'),
      ])
      .where('UserStrike.userId', '=', userId)
      .$if(!includeExpired, (qb) => qb.where('UserStrike.status', '=', 'Active'))
      .$if(includeInternalNotes, (qb) => qb.select('UserStrike.internalNotes'))
      .orderBy('UserStrike.createdAt', 'desc')
      .execute(),
    sql<{ sum: string | null; next_expiry: Date | null }>`
      SELECT SUM(points) as sum, MIN("expiresAt") as next_expiry
      FROM "UserStrike"
      WHERE "userId" = ${userId}
        AND "status" = ${'Active'}::"StrikeStatus"
        AND "expiresAt" > NOW()
    `.execute(db),
  ]);

  const agg = aggregate.rows[0];
  return {
    strikes,
    totalActivePoints: Number(agg?.sum ?? 0),
    nextExpiry: agg?.next_expiry ?? null,
  };
}

// A user's full strike history (expired + internal notes) plus the profile fields the moderator drawer shows.
export async function getStrikeHistoryForMod(db: Kysely<DB>, userId: number) {
  const [strikeData, user] = await Promise.all([
    getStrikesForUser(db, { userId, includeExpired: true, includeInternalNotes: true }),
    db
      .selectFrom('User')
      .select(['id', 'username', 'createdAt', 'muted', 'bannedAt', 'deletedAt', 'meta'])
      .where('id', '=', userId)
      .executeTakeFirst(),
  ]);

  return { ...strikeData, user: user ?? null };
}

// The user id for an exact (case-insensitive) username, or undefined if none. Split out so the
// username-lookup branch of getStrikesForMod is independently testable.
export async function findUserIdByUsername(
  db: Kysely<DB>,
  username: string
): Promise<number | undefined> {
  const row = await db
    .selectFrom('User')
    .select('id')
    .where('username', 'ilike', username)
    .executeTakeFirst();
  return row?.id;
}

// A page of strikes for the moderator dashboard, filtered by user/status/reason, newest first, each joined to
// its target user + issuing moderator. Returns the page items plus the exact total for pagination. When a
// username filter matches no user, short-circuits to an empty page (no query).
export async function getStrikesForMod(
  db: Kysely<DB>,
  input: {
    limit: number;
    page?: number;
    userId?: number;
    username?: string;
    status?: StrikeStatusValue[];
    reason?: StrikeReasonValue[];
  }
) {
  const { limit, page, userId, username, status, reason } = input;
  const take = limit > 0 ? limit : undefined;
  const skip = page && take ? (page - 1) * take : undefined;

  let targetUserId = userId;
  if (username && !userId) {
    targetUserId = await findUserIdByUsername(db, username);
    if (!targetUserId) return { items: [], count: 0 };
  }

  let base = db.selectFrom('UserStrike');
  if (targetUserId) base = base.where('UserStrike.userId', '=', targetUserId);
  if (status?.length) base = base.where('UserStrike.status', 'in', status);
  if (reason?.length) base = base.where('UserStrike.reason', 'in', reason);

  const count = Number(
    (await base.select((eb) => eb.fn.countAll<number>().as('count')).executeTakeFirst())?.count ?? 0
  );

  let itemsQuery = base
    .selectAll('UserStrike')
    .select((eb) => [
      jsonObjectFrom(
        eb
          .selectFrom('User as u')
          .select(['u.id', 'u.username'])
          .whereRef('u.id', '=', 'UserStrike.userId')
      ).as('user'),
      jsonObjectFrom(
        eb
          .selectFrom('User as iu')
          .select(['iu.id', 'iu.username'])
          .whereRef('iu.id', '=', 'UserStrike.issuedBy')
      ).as('issuedByUser'),
    ])
    .orderBy('UserStrike.createdAt', 'desc');
  if (take != null) itemsQuery = itemsQuery.limit(take);
  if (skip != null) itemsQuery = itemsQuery.offset(skip);

  const items = await itemsQuery.execute();

  return { items, count };
}

// ============================================================================
// User standings (dynamic SQL)
// ============================================================================

export type UserStandingRow = {
  id: number;
  username: string | null;
  createdAt: Date;
  muted: boolean;
  bannedAt: Date | null;
  deletedAt: Date | null;
  userScore: number | null;
  flaggedForReview: boolean;
  activeStrikeCount: number;
  totalActivePoints: number;
  totalStrikeCount: number;
  lastStrikeDate: Date | null;
};

// One aggregated row per user for the moderator standings dashboard. Dynamic SQL: an INNER JOIN by default
// (only users with strike history) becomes a LEFT JOIN when searching a specific user (find anyone); the
// WHERE / HAVING / ORDER fragments are assembled from the filters. Sort column/dir come from a fixed map
// (static identifiers — safe as raw SQL). Returns the page items plus the exact total. Ported near-verbatim
// from the moderator app's raw-SQL query.
export async function getUserStandings(
  db: Kysely<DB>,
  input: {
    limit: number;
    page?: number;
    userId?: number;
    username?: string;
    hasActiveStrikes?: boolean;
    isMuted?: boolean;
    isFlaggedForReview?: boolean;
    sort?: 'points' | 'score' | 'lastStrike' | 'created';
    sortOrder?: 'asc' | 'desc';
  }
): Promise<{ items: UserStandingRow[]; count: number }> {
  const {
    limit,
    page,
    userId,
    username,
    hasActiveStrikes,
    isMuted,
    isFlaggedForReview,
    sort = 'points',
    sortOrder = 'desc',
  } = input;
  const take = limit > 0 ? limit : undefined;
  const skip = page && take ? (page - 1) * take : undefined;

  const joinClause =
    userId || username
      ? sql`LEFT JOIN "UserStrike" us ON us."userId" = u."id"`
      : sql`INNER JOIN "UserStrike" us ON us."userId" = u."id"`;

  const whereConditions = [];
  if (userId) whereConditions.push(sql`u."id" = ${userId}`);
  if (username) whereConditions.push(sql`u."username" ILIKE ${'%' + username + '%'}`);
  if (isMuted) whereConditions.push(sql`u."muted" = true`);
  if (isFlaggedForReview)
    whereConditions.push(sql`(u."meta"->>'strikeFlaggedForReview')::boolean = true`);

  const whereClause = whereConditions.length
    ? sql`WHERE ${sql.join(whereConditions, sql` AND `)}`
    : sql``;

  const havingClause = hasActiveStrikes
    ? sql`HAVING COUNT(*) FILTER (WHERE us."status" = 'Active' AND us."expiresAt" > NOW()) > 0`
    : sql``;

  const sortMap: Record<string, string> = {
    points: '"totalActivePoints"',
    score: '"userScore"',
    lastStrike: '"lastStrikeDate"',
    created: 'u."createdAt"',
  };
  const orderColumn = sql.raw(sortMap[sort] ?? '"totalActivePoints"');
  const orderDir = sql.raw(sortOrder === 'asc' ? 'ASC' : 'DESC');

  const baseQuery = sql`
    SELECT
      u."id",
      u."username",
      u."createdAt",
      u."muted",
      u."bannedAt",
      u."deletedAt",
      (u."meta"->'scores'->>'total')::float AS "userScore",
      COALESCE((u."meta"->>'strikeFlaggedForReview')::boolean, false) AS "flaggedForReview",
      COUNT(*) FILTER (WHERE us."status" = 'Active' AND us."expiresAt" > NOW())::int AS "activeStrikeCount",
      COALESCE(SUM(us."points") FILTER (WHERE us."status" = 'Active' AND us."expiresAt" > NOW()), 0)::int AS "totalActivePoints",
      COUNT(us."id")::int AS "totalStrikeCount",
      MAX(us."createdAt") AS "lastStrikeDate"
    FROM "User" u
    ${joinClause}
    ${whereClause}
    GROUP BY u."id"
    ${havingClause}
    ORDER BY ${orderColumn} ${orderDir} NULLS LAST, u."id" DESC
  `;

  const limitClause = take != null ? sql`LIMIT ${take}` : sql``;
  const offsetClause = skip != null ? sql`OFFSET ${skip}` : sql``;

  const [itemsResult, countResult] = await Promise.all([
    sql<UserStandingRow>`${baseQuery} ${limitClause} ${offsetClause}`.execute(db),
    sql<{ count: string }>`SELECT COUNT(*) as count FROM (
      SELECT u."id"
      FROM "User" u
      ${joinClause}
      ${whereClause}
      GROUP BY u."id"
      ${havingClause}
    ) AS sub`.execute(db),
  ]);

  return { items: itemsResult.rows, count: Number(countResult.rows[0]?.count ?? 0) };
}

// ============================================================================
// Escalation engine
// ============================================================================

export type EscalationAction = 'none' | 'muted' | 'muted-and-flagged' | 'unmuted';

// The mute-relevant user state the escalation decision needs.
export function getUserMuteState(db: Kysely<DB>, userId: number) {
  return db
    .selectFrom('User')
    .select(['muted', 'muteExpiresAt', 'meta'])
    .where('id', '=', userId)
    .executeTakeFirst();
}

// Apply a mute-state change. `meta` is written (whole jsonb column, via toJson) only when provided — the
// callers that merely toggle mute leave meta untouched. `mutedAt` is left to the DB's unmute trigger.
export function setUserMuteState(
  db: Kysely<DB>,
  input: { userId: number; muted: boolean; muteExpiresAt: Date | null; meta?: UserMeta }
) {
  return db
    .updateTable('User')
    .set({
      muted: input.muted,
      muteExpiresAt: input.muteExpiresAt,
      ...(input.meta !== undefined ? { meta: toJson(input.meta) } : {}),
    })
    .where('id', '=', input.userId)
    .execute();
}

// DB core of the moderator app's escalation decision. Opens a write transaction, reads the active points
// under a row lock plus the user's mute state, and applies the mute/flag/unmute write — all atomically:
// - >= 3 points: indefinite mute + flag for review
// - >= 2 points: 3-day mute (timer reset each call)
// - < 2 points: unmute + clear flag, but only if the current mute came from strikes (timed or flagged) —
//   never touches a plain manual mute.
// Notifications / session invalidation from the original are the caller's concern and are dropped here.
export function evaluateStrikeEscalation(
  db: Kysely<DB>,
  userId: number
): Promise<{ totalPoints: number; action: EscalationAction }> {
  return db.transaction().execute(async (trx) => {
    const totalPoints = await getActiveStrikePointsForUpdate(trx, userId);
    const user = await getUserMuteState(trx, userId);

    if (!user) return { totalPoints, action: 'none' as EscalationAction };

    const currentMeta = (user.meta as UserMeta | null) ?? {};

    if (totalPoints >= 3) {
      await setUserMuteState(trx, {
        userId,
        muted: true,
        muteExpiresAt: null,
        meta: { ...currentMeta, strikeFlaggedForReview: true, strikeFlaggedAt: new Date() },
      });
      return { totalPoints, action: 'muted-and-flagged' as EscalationAction };
    }

    if (totalPoints >= 2) {
      const muteExpiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      await setUserMuteState(trx, {
        userId,
        muted: true,
        muteExpiresAt,
        meta: currentMeta.strikeFlaggedForReview
          ? { ...currentMeta, strikeFlaggedForReview: false }
          : undefined,
      });
      return { totalPoints, action: 'muted' as EscalationAction };
    }

    if (user.muted && (user.muteExpiresAt !== null || currentMeta.strikeFlaggedForReview)) {
      await setUserMuteState(trx, {
        userId,
        muted: false,
        muteExpiresAt: null,
        meta: currentMeta.strikeFlaggedForReview
          ? { ...currentMeta, strikeFlaggedForReview: false }
          : undefined,
      });
      return { totalPoints, action: 'unmuted' as EscalationAction };
    }

    return { totalPoints, action: 'none' as EscalationAction };
  });
}

// ============================================================================
// Strike CRUD
// ============================================================================

// Insert one strike row, returning the created record.
export function insertUserStrike(
  db: Kysely<DB>,
  input: {
    userId: number;
    reason: StrikeReasonValue;
    points: number;
    description: string;
    internalNotes?: string | null;
    entityType?: EntityTypeValue | null;
    entityId?: number | null;
    reportId?: number | null;
    expiresAt: Date;
    issuedBy?: number | null;
  }
): Promise<UserStrikeRow> {
  return db
    .insertInto('UserStrike')
    .values({
      userId: input.userId,
      reason: input.reason,
      points: input.points,
      description: input.description,
      internalNotes: input.internalNotes ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      reportId: input.reportId ?? null,
      expiresAt: input.expiresAt,
      issuedBy: input.issuedBy ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

// DB core of the moderator app's createStrike, minus its notification + email side-effects. Rate-limits
// non-manual strikes (returns null when limited), inserts the strike, then re-evaluates escalation. The user
// existence check (an app-level 404) is left to the caller.
export async function createStrike(
  db: Kysely<DB>,
  input: {
    userId: number;
    reason: StrikeReasonValue;
    points: number;
    description: string;
    internalNotes?: string | null;
    entityType?: EntityTypeValue | null;
    entityId?: number | null;
    reportId?: number | null;
    expiresInDays: number;
    issuedBy?: number | null;
  }
): Promise<UserStrikeRow | null> {
  const { userId, reason, expiresInDays } = input;

  if (reason !== 'ManualModAction') {
    if (await shouldRateLimitStrike(db, userId)) return null;
  }

  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  const strike = await insertUserStrike(db, {
    userId,
    reason,
    points: input.points,
    description: input.description,
    internalNotes: input.internalNotes,
    entityType: input.entityType,
    entityId: input.entityId,
    reportId: input.reportId,
    expiresAt,
    issuedBy: input.issuedBy,
  });

  await evaluateStrikeEscalation(db, userId);

  return strike;
}

// Atomically void an Active strike (status-guarded to prevent a double-void race), returning the voided row —
// or undefined if it was not currently Active (already voided/expired, or not found). Then re-evaluates
// escalation, which may de-escalate the user. The caller resolves the undefined case (not-found vs
// wrong-status) and any notification.
export async function voidStrike(
  db: Kysely<DB>,
  input: { strikeId: number; voidReason: string; voidedBy: number }
): Promise<UserStrikeRow | undefined> {
  const { strikeId, voidReason, voidedBy } = input;

  const strike = await db
    .updateTable('UserStrike')
    .set({
      status: 'Voided',
      voidedAt: new Date(),
      voidedBy,
      voidReason,
    })
    .where('id', '=', strikeId)
    .where('status', '=', 'Active')
    .returningAll()
    .executeTakeFirst();

  if (!strike) return undefined;

  await evaluateStrikeEscalation(db, strike.userId);

  return strike;
}

// ============================================================================
// Job functions
// ============================================================================

// Expire every Active strike past its expiry in one atomic statement, returning the affected {id, userId}.
// Then re-evaluate escalation per distinct user (sequentially — each opens a FOR UPDATE transaction). Returns
// the number expired. Notifications from the original are dropped.
export async function expireStrikes(db: Kysely<DB>): Promise<{ expiredCount: number }> {
  const expired = await db
    .updateTable('UserStrike')
    .set({ status: 'Expired' })
    .where('status', '=', 'Active')
    .where('expiresAt', '<=', new Date())
    .returning(['id', 'userId'])
    .execute();

  if (expired.length === 0) return { expiredCount: 0 };

  const uniqueUserIds = [...new Set(expired.map((s) => s.userId))];
  for (const userId of uniqueUserIds) {
    await evaluateStrikeEscalation(db, userId);
  }

  return { expiredCount: expired.length };
}

// Users whose timed mute has lapsed (muted, a non-null muteExpiresAt now in the past). Split out so the scan
// is independently testable.
export function getUsersToUnmute(db: Kysely<DB>) {
  return db
    .selectFrom('User')
    .select('id')
    .where('muted', '=', true)
    .where('muteExpiresAt', 'is not', null)
    .where('muteExpiresAt', '<=', new Date())
    .execute();
}

// Process lapsed timed mutes. For each candidate, re-evaluate escalation first (it re-mutes if points are
// still >= 2); only when escalation returns 'none' does this actually clear the mute. Returns how many users
// ended up unmuted. Session refreshes from the original are dropped.
export async function processTimedUnmutes(db: Kysely<DB>): Promise<{ unmutedCount: number }> {
  const usersToUnmute = await getUsersToUnmute(db);
  if (usersToUnmute.length === 0) return { unmutedCount: 0 };

  let unmutedCount = 0;
  for (const { id } of usersToUnmute) {
    const { action } = await evaluateStrikeEscalation(db, id);

    if (action === 'none') {
      await setUserMuteState(db, { userId: id, muted: false, muteExpiresAt: null });
      unmutedCount++;
    } else if (action === 'unmuted') {
      unmutedCount++;
    }
  }

  return { unmutedCount };
}
