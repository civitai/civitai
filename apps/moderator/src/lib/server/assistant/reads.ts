import { sql } from '@civitai/db/kysely';
import { DEFAULT_REPORT_STATUSES, ReportReason } from '$lib/reports';
import { dbRead } from '../db';
import { escapeLike } from '../like';
import { strikeCountsByUserIds } from '../moderation-memory.service';
import { isInt4Id, SYSTEM_USER_ID } from '../users.service';

// Reads only the assistant asks for. A shape that would scan `User` is refused with the reason, which
// the model relays.

export type AccountRow = {
  userId: number;
  username: string | null;
  createdAt: Date;
  bannedAt: Date | null;
  banReason: string | null;
  deletedAt: Date | null;
  muted: boolean;
  strikes: number;
};

const accountColumns = [
  'id',
  'username',
  'createdAt',
  'bannedAt',
  'deletedAt',
  'muted',
  sql<string | null>`meta #>> '{banDetails,reasonCode}'`.as('banReason'),
] as const;

async function withStrikes(
  rows: {
    id: number;
    username: string | null;
    createdAt: Date;
    bannedAt: Date | null;
    deletedAt: Date | null;
    muted: boolean | null;
    banReason: string | null;
  }[]
): Promise<AccountRow[]> {
  const strikes = await strikeCountsByUserIds(rows.map((r) => r.id)).catch(
    () => new Map<number, number>()
  );
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    createdAt: r.createdAt,
    bannedAt: r.bannedAt,
    banReason: r.banReason,
    deletedAt: r.deletedAt,
    muted: !!r.muted,
    strikes: strikes.get(r.id) ?? 0,
  }));
}

export const MAX_ACCOUNTS = 200;

/** A moderator's list of ids, resolved: who each one is and where they stand. Unknown ids are reported. */
export async function getAccounts(
  userIds: number[]
): Promise<{ accounts: AccountRow[]; missing: number[] }> {
  const ids = [...new Set(userIds)].filter(isInt4Id).slice(0, MAX_ACCOUNTS);
  if (!ids.length) return { accounts: [], missing: [] };
  const rows = await dbRead
    .selectFrom('User')
    .select(accountColumns)
    .where('id', 'in', ids)
    .execute();
  const found = new Set(rows.map((r) => r.id));
  return { accounts: await withStrikes(rows), missing: ids.filter((id) => !found.has(id)) };
}

/**
 * The next string after every string starting with `prefix`, for a btree range scan. `username` is
 * citext, which compares case-insensitively, so the bound is taken on the lowercased prefix.
 */
export function prefixUpperBound(prefix: string): string {
  const lower = prefix.toLowerCase();
  const last = lower.charCodeAt(lower.length - 1);
  return lower.slice(0, -1) + String.fromCharCode(last + 1);
}

export type AccountSearch = {
  usernamePrefix?: string;
  usernameContains?: string;
  banned: 'only' | 'exclude' | 'any';
  createdAfter?: Date;
  createdBefore?: Date;
  limit: number;
};

/** A substring search reads every row it cannot rule out; these are the two populations small enough. */
export const CONTAINS_WINDOW_DAYS = 31;

export function searchRefusal(q: AccountSearch): string | null {
  if (!q.usernamePrefix && !q.usernameContains && !q.createdAfter)
    return 'Give a username prefix, a username fragment, or a createdAfter date.';
  if (q.usernameContains && q.banned !== 'only') {
    const after = q.createdAfter?.getTime();
    const before = (q.createdBefore ?? new Date()).getTime();
    if (!after || before - after > CONTAINS_WINDOW_DAYS * 86_400_000)
      return `A username fragment search needs banned: "only", or a createdAfter/createdBefore window of at most ${CONTAINS_WINDOW_DAYS} days. A prefix search has no such limit.`;
  }
  if (q.createdAfter && !q.usernamePrefix && !q.usernameContains) {
    const before = (q.createdBefore ?? new Date()).getTime();
    if (before - q.createdAfter.getTime() > CONTAINS_WINDOW_DAYS * 86_400_000)
      return `A signup-date search without a username needs a window of at most ${CONTAINS_WINDOW_DAYS} days.`;
  }
  return null;
}

/**
 * Accounts by username and signup date — the "I banned an account named like this before" search.
 *
 * 🔴 A prefix is a RANGE on the username index, never `LIKE 'x%'`: `username` is citext, and the
 * planner does not use the btree for a citext LIKE, so the prefix form scans the whole table.
 */
export async function searchAccounts(
  q: AccountSearch
): Promise<{ accounts: AccountRow[]; truncated: boolean } | { refused: string }> {
  const refused = searchRefusal(q);
  if (refused) return { refused };
  const limit = Math.min(MAX_ACCOUNTS, Math.max(1, q.limit));

  let query = dbRead.selectFrom('User').select(accountColumns).where('id', '!=', SYSTEM_USER_ID);
  if (q.usernamePrefix)
    query = query
      .where('username', '>=', q.usernamePrefix.toLowerCase())
      .where('username', '<', prefixUpperBound(q.usernamePrefix));
  if (q.usernameContains)
    query = query.where(sql<boolean>`username ILIKE ${`%${escapeLike(q.usernameContains)}%`}`);
  if (q.banned === 'only') query = query.where('bannedAt', 'is not', null);
  if (q.banned === 'exclude') query = query.where('bannedAt', 'is', null);
  if (q.createdAfter) query = query.where('createdAt', '>=', q.createdAfter);
  if (q.createdBefore) query = query.where('createdAt', '<', q.createdBefore);
  // The signup-date index is partial on live accounts; a date-bounded search without it scans.
  if (q.createdAfter && q.banned !== 'only') query = query.where('deletedAt', 'is', null);

  const rows = await query
    .orderBy(q.banned === 'only' ? 'bannedAt' : 'createdAt', 'desc')
    .limit(limit + 1)
    .execute();
  return { accounts: await withStrikes(rows.slice(0, limit)), truncated: rows.length > limit };
}

export type OpenUserReport = {
  reportId: number;
  /** The reported account. */
  userId: number;
  reason: string;
  status: string;
  createdAt: Date;
  reporterId: number;
  comment: string | null;
  alsoReportedBy: number;
};

/** The reasons a person can file a report under; `Automated` is never a human report. */
export const HUMAN_REPORT_REASONS = Object.values(ReportReason).filter(
  (r) => r !== ReportReason.Automated
);

export type OpenUserReportQuery = {
  limit?: number;
  order?: 'newest' | 'oldest';
  /** Keyset: the last report id of the previous page, in the same `order`. */
  cursor?: number;
  statuses?: readonly string[];
  reasons?: readonly string[];
};

/**
 * Open user reports, human-filed only: the queue the moderator works. Reads the
 * `Report_open_reason_id_idx` partial index, which holds exactly the open rows.
 */
export async function getOpenUserReports({
  limit = 50,
  order = 'newest',
  cursor,
  statuses,
  reasons,
}: OpenUserReportQuery = {}): Promise<OpenUserReport[]> {
  // These become SQL literals, so they are taken from the fixed lists, never from the caller.
  // Nothing matching falls back to the whole open queue: never an empty `IN ()`, never a closed status.
  const picked = DEFAULT_REPORT_STATUSES.filter((s) => statuses?.includes(s));
  const status = picked.length ? picked : DEFAULT_REPORT_STATUSES;
  const reason = HUMAN_REPORT_REASONS.filter((r) => reasons?.includes(r));
  const newest = order === 'newest';
  const rows = await dbRead
    .selectFrom('Report as r')
    .innerJoin('UserReport as ur', 'ur.reportId', 'r.id')
    .select([
      'r.id',
      'ur.userId',
      sql<string>`r.reason::text`.as('reason'),
      sql<string>`r.status::text`.as('status'),
      'r.createdAt',
      'r.userId as reporterId',
      sql<string | null>`r.details ->> 'comment'`.as('comment'),
      sql<number>`coalesce(cardinality(r."alsoReportedBy"), 0)`.as('alsoReportedBy'),
    ])
    // Literals, not bind parameters: a generic plan cannot prove a partial index's predicate from $1.
    .where(sql<boolean>`r.status IN (${sql.join(status.map((s) => sql.lit(s)))})`)
    .where(sql<boolean>`r.reason != ${sql.lit(ReportReason.Automated)}`)
    .$if(reason.length > 0, (qb) =>
      qb.where(sql<boolean>`r.reason IN (${sql.join(reason.map((r) => sql.lit(r)))})`)
    )
    .$if(!!cursor, (qb) => qb.where('r.id', newest ? '<' : '>', cursor!))
    .orderBy('r.id', newest ? 'desc' : 'asc')
    .limit(Math.min(100, Math.max(1, limit)))
    .execute();
  return rows.map((r) => ({
    reportId: r.id,
    userId: r.userId,
    reason: r.reason,
    status: r.status,
    createdAt: r.createdAt,
    reporterId: r.reporterId,
    comment: r.comment,
    alsoReportedBy: Number(r.alsoReportedBy),
  }));
}
