import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { callModEndpoint, type JsonResult } from './user-actions.service';

// The main app's FILE_CHECKED_BOUNTY_TYPES: the bounties whose entry files are hashed.
const CHECKED_TYPES = ['ModelCreation', 'LoraCreation', 'EmbedCreation'];

type EntryFile = {
  fileId: number;
  fileName: string;
  entryId: number;
  entrantId: number | null;
  entrant: string | null;
  bountyId: number;
  bountyName: string;
};

export type BlockedEntryFile = EntryFile & {
  checkedAt: string | null;
  /** A model of another user's with this file, for the moderator to compare against. */
  matchModelId: number | null;
  matchModelName: string | null;
  matchOwner: string | null;
};

export type StuckEntryFile = EntryFile & {
  failCount: number;
  lastError: string | null;
  attemptedAt: string | null;
  expiresAt: Date;
};

export type ClearedEntryFile = EntryFile & {
  clearedAt: Date;
  moderator: string | null;
  reason: string | null;
};

const entryFileColumns = sql`
  f.id AS "fileId", f.name AS "fileName", be.id AS "entryId",
  be."userId" AS "entrantId", u.username AS entrant, b.id AS "bountyId", b.name AS "bountyName"
`;

/** Entry files of open model bounties the check refused and no moderator has cleared, oldest first. */
export async function getBlockedEntryFiles(limit: number) {
  const { rows } = await sql<BlockedEntryFile>`
    SELECT ${entryFileColumns}, f.metadata->>'hashCheckedAt' AS "checkedAt",
           m.id AS "matchModelId", m.name AS "matchModelName", mu.username AS "matchOwner"
    FROM "Bounty" b
    JOIN "BountyEntry" be ON be."bountyId" = b.id
    JOIN "File" f ON f."entityType" = 'BountyEntry' AND f."entityId" = be.id
    LEFT JOIN "User" u ON u.id = be."userId"
    LEFT JOIN LATERAL (
      SELECT m.id, m.name, m."userId"
      FROM "ModelFileHash" mfh
      JOIN "ModelFile" mf ON mf.id = mfh."fileId"
      JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE mfh.hash = (f.metadata->>'sha256Server')::citext
        AND m."deletedAt" IS NULL
        AND m."userId" IS DISTINCT FROM be."userId"
      LIMIT 1
    ) m ON true
    LEFT JOIN "User" mu ON mu.id = m."userId"
    WHERE b.type::text = ANY(${CHECKED_TYPES})
      AND NOT b.complete
      AND NOT b.refunded
      AND f.metadata->>'blockedReason' IS NOT NULL
      AND f.metadata->'checkOverride' IS NULL
    ORDER BY f.metadata->>'hashCheckedAt', f.id
    LIMIT ${limit + 1}
  `.execute(dbRead);
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

/**
 * Entry files of open model bounties the check has tried and failed to hash. Award refuses them,
 * and a bounty with one waits at expiry rather than auto-awarding.
 */
export async function getStuckEntryFiles(limit: number) {
  const { rows } = await sql<StuckEntryFile>`
    SELECT ${entryFileColumns},
           (f.metadata->>'hashFailCount')::int AS "failCount",
           f.metadata->>'hashLastError' AS "lastError",
           f.metadata->>'hashAttemptedAt' AS "attemptedAt",
           b."expiresAt"
    FROM "Bounty" b
    JOIN "BountyEntry" be ON be."bountyId" = b.id
    JOIN "File" f ON f."entityType" = 'BountyEntry' AND f."entityId" = be.id
    LEFT JOIN "User" u ON u.id = be."userId"
    WHERE b.type::text = ANY(${CHECKED_TYPES})
      AND NOT b.complete
      AND NOT b.refunded
      AND f.metadata->>'hashCheckedAt' IS NULL
      AND (f.metadata->>'hashFailCount')::int > 0
    ORDER BY b."expiresAt", f.id
    LIMIT ${limit + 1}
  `.execute(dbRead);
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

/**
 * Files still carrying a moderator's clear, newest first. The entries come from the ModActivity rows
 * the clear writes; a file re-uploaded since has lost its clear and drops off.
 */
export async function getClearedEntryFiles(limit: number) {
  const { rows } = await sql<ClearedEntryFile>`
    SELECT ${entryFileColumns},
           (f.metadata->'checkOverride'->>'at')::timestamptz AS "clearedAt",
           mu.username AS moderator,
           f.metadata->'checkOverride'->>'reason' AS reason
    FROM "BountyEntry" be
    JOIN "Bounty" b ON b.id = be."bountyId"
    JOIN "File" f ON f."entityType" = 'BountyEntry' AND f."entityId" = be.id
    LEFT JOIN "User" u ON u.id = be."userId"
    LEFT JOIN "User" mu ON mu.id = (f.metadata->'checkOverride'->>'by')::int
    WHERE be.id IN (
        SELECT "entityId" FROM "ModActivity"
        WHERE "entityType" = 'bountyEntry' AND activity = 'clearFileCheck'
      )
      AND f.metadata->'checkOverride' IS NOT NULL
    ORDER BY "clearedAt" DESC, f.id
    LIMIT ${limit}
  `.execute(dbRead);
  return rows;
}

export const clearEntryFileCheck = (fileId: number, reason: string): Promise<JsonResult> =>
  callModEndpoint('bounty-entry-file/clear-check', { fileId, reason }, 'Clear file check');
