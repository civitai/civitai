import { sql, type RawBuilder } from '@civitai/db/kysely';
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
  bountyComplete: boolean;
  bountyRefunded: boolean;
};

export type StuckEntryFile = EntryFile & {
  failCount: number;
  lastError: string | null;
  attemptedAt: string | null;
  expiresAt: Date;
};

export type ClearedEntryFile = EntryFile & {
  /** ISO timestamp, as the clear wrote it. */
  clearedAt: string;
  moderator: string | null;
  reason: string | null;
  /** A re-block withholds the file again but leaves an award already made. */
  entryAwarded: boolean;
  bountyComplete: boolean;
  bountyRefunded: boolean;
};

// The main app's VALID_OVERRIDE_SQL: only the shape a clear writes counts. Pinned equal to it by
// src/server/services/__tests__/bounty-entry-file-check.parity.test.ts.
const validOverride = sql`(
  jsonb_typeof(f.metadata->'checkOverride'->'by') = 'number'
  AND (f.metadata->'checkOverride'->>'by') ~ '^[1-9][0-9]{0,14}$'
  AND jsonb_typeof(f.metadata->'checkOverride'->'at') = 'string'
  AND jsonb_typeof(f.metadata->'checkOverride'->'reason') = 'string'
  AND (f.metadata->'checkOverride'->>'reason')
    ~ ('[^ ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || ']')
)`;

// The main app's HASH_FAIL_COUNT_SQL: a planted non-count reads as 0 rather than throwing. Pinned
// equal to it by the same test.
const failCount = sql`CASE WHEN jsonb_typeof(f.metadata->'hashFailCount') = 'number'
  AND (f.metadata->>'hashFailCount') ~ '^[0-9]{1,6}$'
  THEN (f.metadata->>'hashFailCount')::int ELSE 0 END`;

const entryFileColumns = sql`
  f.id AS "fileId", f.name AS "fileName", be.id AS "entryId",
  be."userId" AS "entrantId", u.username AS entrant, b.id AS "bountyId", b.name AS "bountyName"
`;

/**
 * Entry files the check refused and no moderator has cleared, oldest first: on open model bounties,
 * and on settled ones when a moderator re-blocked the file, so it can be cleared again. Two
 * branches, not an OR: an OR loses the open-bounty narrowing and walks every settled bounty.
 */
export async function getBlockedEntryFiles(limit: number) {
  const { rows } = await sql<BlockedEntryFile>`
    SELECT * FROM (
      (${blockedEntryFiles(sql`NOT b.complete AND NOT b.refunded`)})
      UNION ALL
      (${blockedEntryFiles(sql`(b.complete OR b.refunded)
        AND be.id IN (
          SELECT "entityId" FROM "ModActivity"
          WHERE "entityType" = 'bountyEntry' AND activity LIKE 'reblockFileCheck:%'
        )
        AND EXISTS (
          SELECT 1 FROM "ModActivity" ma
          WHERE ma."entityType" = 'bountyEntry' AND ma."entityId" = be.id
            AND ma.activity LIKE ('reblockFileCheck:{"fileId":' || f.id || ',%')
        )`)})
    ) blocked
    ORDER BY "checkedAt", "fileId"
    LIMIT ${limit + 1}
  `.execute(dbRead);
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

/** Blocked entry files of model bounties, narrowed by `where` over `b`, `be` and `f`. */
function blockedEntryFiles(where: RawBuilder<unknown>) {
  return sql`
    SELECT ${entryFileColumns}, f.metadata->>'hashCheckedAt' AS "checkedAt",
           m.id AS "matchModelId", m.name AS "matchModelName", mu.username AS "matchOwner",
           b.complete AS "bountyComplete", b.refunded AS "bountyRefunded"
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
      AND ${where}
      AND f.metadata->>'blockedReason' IS NOT NULL
      AND NOT COALESCE(${validOverride}, false)
  `;
}

/**
 * Entry files of open model bounties the check has tried and failed to hash. Award refuses them,
 * and a bounty with one waits at expiry rather than auto-awarding.
 */
export async function getStuckEntryFiles(limit: number) {
  const { rows } = await sql<StuckEntryFile>`
    SELECT ${entryFileColumns},
           ${failCount} AS "failCount",
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
      AND ${failCount} > 0
    ORDER BY b."expiresAt", f.id
    LIMIT ${limit + 1}
  `.execute(dbRead);
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

/**
 * Files still carrying a moderator's clear, newest first. The entries come from the ModActivity rows
 * the clear writes; a file re-uploaded or re-blocked since has lost its clear and drops off.
 */
export async function getClearedEntryFiles(limit: number) {
  const { rows } = await sql<ClearedEntryFile>`
    SELECT ${entryFileColumns},
           f.metadata->'checkOverride'->>'at' AS "clearedAt",
           mu.username AS moderator,
           f.metadata->'checkOverride'->>'reason' AS reason,
           EXISTS (
             SELECT 1 FROM "BountyBenefactor" bb
             WHERE bb."bountyId" = b.id AND bb."awardedToId" = be.id
           ) AS "entryAwarded",
           b.complete AS "bountyComplete",
           b.refunded AS "bountyRefunded"
    FROM "BountyEntry" be
    JOIN "Bounty" b ON b.id = be."bountyId"
    JOIN "File" f ON f."entityType" = 'BountyEntry' AND f."entityId" = be.id
    LEFT JOIN "User" u ON u.id = be."userId"
    LEFT JOIN "User" mu ON mu.id = CASE WHEN ${validOverride}
      THEN (f.metadata->'checkOverride'->>'by')::bigint END
    WHERE be.id IN (
        SELECT "entityId" FROM "ModActivity"
        WHERE "entityType" = 'bountyEntry' AND activity LIKE 'clearFileCheck:%'
      )
      AND ${validOverride}
    ORDER BY "clearedAt" DESC, f.id
    LIMIT ${limit}
  `.execute(dbRead);
  return rows;
}

export const clearEntryFileCheck = (fileId: number, reason: string): Promise<JsonResult> =>
  callModEndpoint('bounty-entry-file/clear-check', { fileId, reason }, 'Clear file check');

export const reblockEntryFileCheck = (fileId: number, reason: string): Promise<JsonResult> =>
  callModEndpoint('bounty-entry-file/reblock-check', { fileId, reason }, 'Re-block file');
