import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import type { AppealResult } from './minor-flag.service';
import { callModEndpoint } from './user-actions.service';

export type BountyPoiVerdict = {
  at?: string;
  reason?: string;
  names?: string[];
  appealGranted?: { at: string; by: number };
};

export type BountyPoiAppealRow = {
  appealId: number;
  appealMessage: string;
  appealCreatedAt: Date;
  bountyId: number;
  bountyName: string;
  userId: number | null;
  username: string | null;
  poi: boolean;
  availability: string;
  expiresAt: Date;
  textScanPoi: BountyPoiVerdict | null;
};

export async function getBountyPoiAppeals({
  limit,
  offset = 0,
}: {
  limit: number;
  offset?: number;
}) {
  const rows = await sql<BountyPoiAppealRow>`
    SELECT a.id AS "appealId", a."appealMessage", a."createdAt" AS "appealCreatedAt",
           b.id AS "bountyId", b.name AS "bountyName", b."userId", u.username,
           b.poi, b.availability::text AS availability, b."expiresAt",
           b.meta->'textScanFlags'->'poi' AS "textScanPoi"
    FROM "Appeal" a
    JOIN "Bounty" b ON b.id = a."entityId"
    LEFT JOIN "User" u ON u.id = b."userId"
    WHERE a."entityType" = 'Bounty'
      AND a.status::text = 'Pending'
    ORDER BY a."createdAt", a.id
    LIMIT ${limit + 1} OFFSET ${offset}
  `.execute(dbRead);

  return { items: rows.rows.slice(0, limit), hasMore: rows.rows.length > limit };
}

// The grant records the text hash it covers, which only the main app can compute.
export async function resolveBountyPoiAppeal(
  bountyId: number,
  uphold: boolean
): Promise<AppealResult> {
  const result = await callModEndpoint(
    'bounty-poi/resolve-appeal',
    { bountyId, uphold },
    uphold ? 'Uphold flag' : 'Overturn flag'
  );
  if (!result.ok) return result;
  return { ok: true, rescanQueued: result.body.rescanQueued === true };
}
