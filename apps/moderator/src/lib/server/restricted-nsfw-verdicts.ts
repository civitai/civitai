import { sql } from '@civitai/db/kysely';
import { restrictedLeadRevision } from '@civitai/shared/restricted-lead-revision';
import { loadComFaces } from './com-face';
import { dbRead } from './db';
import type { RestrictedVerdictRow } from '$lib/minor-flags/restricted-verdicts';

/** MUST match the predicate of the partial index `Model_restrictedNsfwVerdict_idx` (see its
 *  migration) character for character, or the sidebar count scans "Model". */
const pendingPredicate = sql`(m.meta ? 'restrictedNsfwVerdict')`;

const restrictionSql = sql`CASE
  WHEN m.minor OR m.meta->'restrictedNsfwVerdict'->>'restriction' = 'minor' THEN 'minor'
  WHEN m.poi OR m.meta->'restrictedNsfwVerdict'->>'restriction' = 'poi' THEN 'poi'
  ELSE 'sfwOnly' END`;

/** Every pending lead, minor first, then POI, then SFW-only, oldest first within each. The queue is
 *  small, so unpaged and capped at `limit`. */
export async function getRestrictedVerdicts(limit = 100): Promise<RestrictedVerdictRow[]> {
  const result = await sql<
    Omit<RestrictedVerdictRow, 'comFace' | 'revision'> & {
      sfwName: string | null;
      sfwCoverImageId: number | null;
    } & RevisionColumns
  >`
    SELECT m.id AS "modelId", m.name AS "modelName", m."userId", u.username,
      m."sfwName", m."sfwCoverImageId",
      ${restrictionSql} AS restriction,
      m.minor, m.poi, m."sfwOnly", m.nsfw, (m.availability::text = 'Private') AS "isPrivate",
      (m.meta ? 'systemNsfwLock' AND 'nsfw' = ANY(m."lockedProperties")) AS "systemLocked",
      (m.meta->'restrictedNsfwVerdict' ? 'applied') AS "autoApplied",
      ((m.meta->'restrictedNsfwVerdict'->>'restriction' IN ('minor', 'poi')
        AND NOT m.minor AND NOT m.poi)
        OR m.meta->'restrictedNsfwVerdict' ? 'liftedBy') AS unticked,
      m.meta->'restrictedNsfwVerdict'->>'liftedBy' AS "liftedBy",
      m.meta->'restrictedNsfwVerdict'->>'at' AS "heldAt",
      m.meta->'restrictedNsfwVerdict'->>'source' AS source,
      m.meta->'restrictedNsfwVerdict'->>'restriction' AS "leadRestriction",
      m.meta->'restrictedNsfwVerdict'->'applied'->>'at' AS "leadAppliedAt",
      m.meta->'restrictedNsfwVerdictRulings'->-1->>'at' AS "lastRulingAt",
      m."lockedProperties",
      m.meta->'systemNsfwLock'->>'at' AS "systemNsfwLockAt",
      m.meta->'textModeration'->>'scannedAt' AS "forensicsScannedAt",
      em."contentHash" AS "scanContentHash",
      em."nsfwLevel" AS "scanLevel",
      COALESCE(em."triggeredLabels", ARRAY[]::text[]) AS "scanLabels",
      em.result->'labels'->'nsfw'->>'reason' AS "scanReason",
      m.meta->'textModeration' AS forensics
    FROM "Model" m
    LEFT JOIN "User" u ON u.id = m."userId"
    LEFT JOIN LATERAL (
      SELECT e."nsfwLevel", e."triggeredLabels", e.result, e."contentHash"
      FROM "EntityModeration" e
      WHERE e."entityType" = 'Model' AND e."entityId" = m.id
      ORDER BY e."updatedAt" DESC
      LIMIT 1
    ) em ON TRUE
    WHERE ${pendingPredicate}
    ORDER BY CASE ${restrictionSql} WHEN 'minor' THEN 0 WHEN 'poi' THEN 1 ELSE 2 END,
      m.meta->'restrictedNsfwVerdict'->>'at', m.id
    LIMIT ${limit}
  `.execute(dbRead);
  const comFaces = await loadComFaces(
    result.rows.map((r) => ({
      id: r.modelId,
      sfwName: r.sfwName,
      sfwCoverImageId: r.sfwCoverImageId,
    }))
  );
  return result.rows.map(
    ({
      sfwName: _n,
      sfwCoverImageId: _c,
      leadRestriction,
      leadAppliedAt,
      lastRulingAt,
      lockedProperties,
      systemNsfwLockAt,
      forensicsScannedAt,
      scanContentHash,
      ...r
    }) => ({
      ...r,
      comFace: comFaces.get(r.modelId) ?? null,
      revision: restrictedLeadRevision({
        lead: {
          at: r.heldAt,
          source: r.source,
          restriction: leadRestriction,
          liftedBy: r.liftedBy,
          appliedAt: leadAppliedAt,
        },
        lastRulingAt,
        model: {
          minor: r.minor,
          poi: r.poi,
          isPrivate: r.isPrivate,
          nsfw: r.nsfw,
          sfwOnly: r.sfwOnly,
          locks: lockedProperties ?? [],
          systemNsfwLockAt,
        },
        scan: {
          nsfwLevel: r.scanLevel,
          triggeredLabels: r.scanLabels,
          nsfwReason: r.scanReason,
          contentHash: scanContentHash,
          forensicsScannedAt,
        },
      }),
    })
  );
}

type RevisionColumns = {
  leadRestriction: string | null;
  leadAppliedAt: string | null;
  lastRulingAt: string | null;
  lockedProperties: string[] | null;
  systemNsfwLockAt: string | null;
  forensicsScannedAt: string | null;
  scanContentHash: string | null;
};

export async function getRestrictedVerdictCount(): Promise<number> {
  const result = await sql<{ count: number }>`
    SELECT count(*)::int AS count FROM "Model" m WHERE ${pendingPredicate}
  `.execute(dbRead);
  return result.rows[0]?.count ?? 0;
}
