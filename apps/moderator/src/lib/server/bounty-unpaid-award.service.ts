import { sql } from '@civitai/db/kysely';
import type { BountyAwardRuling } from '@civitai/shared/bounty-award';
import { dbRead } from './db';

export type UnpaidAwardRow = {
  bountyId: number;
  /** Null once the bounty is deleted: the record outlives it. */
  bountyName: string | null;
  userId: number;
  supporter: string | null;
  unitAmount: number;
  buzzTransactionIds: string[];
  /** Null on a supporter refund that could not be confirmed: there is no winner to pay. */
  winnerUserId: number | null;
  winner: string | null;
  ownerId: number | null;
  owner: string | null;
  recordedBy: string | null;
  recordedAt: Date;
  /** Recorded only in ModActivity, before the table existed; resolving it creates its row. */
  legacy: boolean;
  ruling: BountyAwardRuling | null;
  ledgerReference: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
};

const ACTIVITY_UNPAID = 'bountyAwardUnpaid';
export const RESOLVED_WINDOW_DAYS = 30;

/** Mirrors `resolveUnpaidBountyAward`'s fallback: a ModActivity record whose bounty and supporter row
 *  still exist and that has no table row yet. */
const legacyOpen = sql`
  SELECT * FROM (
  SELECT DISTINCT ON (m."entityId", m."userId")
         m."entityId" AS "bountyId", m."userId", bb."unitAmount",
         COALESCE(bb."buzzTransactionId", ARRAY[]::text[]) AS "buzzTransactionIds",
         b."payoutWinnerUserId" AS "winnerUserId",
         COALESCE(b."userId", (b.meta ->> 'userIdBeforeRemoval')::int) AS "ownerId",
         NULL::int AS "recordedById", m."createdAt" AS "recordedAt", true AS legacy,
         NULL::text AS ruling, NULL::text AS "ledgerReference",
         NULL::int AS "resolvedById", NULL::timestamp AS "resolvedAt"
  FROM "ModActivity" m
  JOIN "Bounty" b ON b.id = m."entityId"
  JOIN "BountyBenefactor" bb ON bb."bountyId" = m."entityId" AND bb."userId" = m."userId"
  WHERE m."entityType" = 'bounty' AND m.activity = ${ACTIVITY_UNPAID}
    AND NOT EXISTS (
      SELECT 1 FROM "BountyUnpaidAward" a
      WHERE a."bountyId" = m."entityId" AND a."userId" = m."userId"
    )
  ORDER BY m."entityId", m."userId", m."createdAt"
  ) legacy`;

const tableRows = (resolved: boolean) => sql`
  SELECT a."bountyId", a."userId", a."unitAmount", a."buzzTransactionIds", a."winnerUserId",
         a."ownerId", a."recordedById", a."recordedAt", false AS legacy,
         a.ruling, a."ledgerReference", a."resolvedById", a."resolvedAt"
  FROM "BountyUnpaidAward" a
  WHERE ${
    resolved
      ? sql`a."resolvedAt" > now() - make_interval(days => ${RESOLVED_WINDOW_DAYS})`
      : sql`a."resolvedAt" IS NULL`
  }`;

/** The table comes from a migration applied by hand; an environment without it has nothing to
 *  resolve either (the main app refuses), so the page says so and the count is zero. */
export async function unpaidAwardTableExists(): Promise<boolean> {
  const { rows } = await sql<{ exists: boolean }>`
    SELECT to_regclass('"BountyUnpaidAward"') IS NOT NULL AS exists
  `.execute(dbRead);
  return rows[0]?.exists === true;
}

export async function getUnpaidAwards({
  resolved,
  limit,
}: {
  resolved: boolean;
  limit: number;
}): Promise<{ items: UnpaidAwardRow[]; hasMore: boolean }> {
  const source = resolved ? tableRows(true) : sql`${tableRows(false)} UNION ALL ${legacyOpen}`;
  const { rows } = await sql<UnpaidAwardRow>`
    SELECT r."bountyId", b.name AS "bountyName", r."userId", su.username AS supporter,
           r."unitAmount", r."buzzTransactionIds", r."winnerUserId", wu.username AS winner,
           r."ownerId", ou.username AS owner, rb.username AS "recordedBy", r."recordedAt",
           r.legacy, r.ruling, r."ledgerReference", vb.username AS "resolvedBy", r."resolvedAt"
    FROM (${source}) r
    LEFT JOIN "Bounty" b ON b.id = r."bountyId"
    LEFT JOIN "User" su ON su.id = r."userId"
    LEFT JOIN "User" wu ON wu.id = r."winnerUserId"
    LEFT JOIN "User" ou ON ou.id = r."ownerId"
    LEFT JOIN "User" rb ON rb.id = r."recordedById"
    LEFT JOIN "User" vb ON vb.id = r."resolvedById"
    ORDER BY ${resolved ? sql`r."resolvedAt" DESC` : sql`r."recordedAt"`}, r."bountyId", r."userId"
    LIMIT ${limit + 1}
  `.execute(dbRead);
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function countOpenUnpaidAwards(): Promise<number> {
  if (!(await unpaidAwardTableExists())) return 0;
  const { rows } = await sql<{ count: number }>`
    SELECT count(*)::int AS count FROM (${tableRows(false)} UNION ALL ${legacyOpen}) r
  `.execute(dbRead);
  return rows[0]?.count ?? 0;
}
