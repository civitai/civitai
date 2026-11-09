import type { NextApiRequest } from 'next';
import { sql } from 'kysely';
import type { DownloadRequest } from '~/pages/api/download/models/[modelVersionId]';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { logToAxiom } from '~/server/logging/client';
import type { getFileForModelVersion } from '~/server/services/file.service';

/** The URL segment for each hash the scanner computes from a file's stored bytes. */
export const DOWNLOAD_HASH_TYPES = { sha256: 'SHA256', blake3: 'BLAKE3' } as const;
export type DownloadHashKind = keyof typeof DOWNLOAD_HASH_TYPES;

/** The most copies of one hash that are run through the download gate per request. */
export const MAX_HASH_CANDIDATES = 5;

/** Identical bytes have identical sizes, so live copies further apart than this carry a wrong hash. */
const SIZE_MISMATCH_TOLERANCE_KB = 1;

/** Both hash kinds are 64 hex characters. Stored upper-case. */
export function parseContentHash(raw: unknown): string | null {
  return typeof raw === 'string' && /^[0-9a-f]{64}$/i.test(raw) ? raw.toUpperCase() : null;
}

type GateResult = Awaited<ReturnType<typeof getFileForModelVersion>>;
type GateStatus = GateResult['status'];
export type HashGate = (args: { modelVersionId: number; fileId: number }) => Promise<GateResult>;

type Viewer = { id?: number; isModerator?: boolean | null };

export type HashCandidate = {
  fileId: number;
  modelVersionId: number;
  groupSize: number;
  liveCount: number;
  takenDownFileIds: number[] | null;
  groupSizeSpreadKB: number;
  liveSizeSpreadKB: number;
};

/**
 * Every copy of the content, pre-filtered to the ones the gate could pass for this viewer and
 * ordered so the likeliest pass is tried first. The pre-filter only narrows: the gate still
 * decides every candidate. One index lookup on the hash, then primary-key joins.
 */
export async function findHashCandidates({
  hash,
  kind,
  viewer,
}: {
  hash: string;
  kind: DownloadHashKind;
  viewer?: Viewer;
}): Promise<HashCandidate[]> {
  const { kyselyRead } = await loadKyselyDb();
  const userId = viewer?.id ?? null;
  const isMod = !!viewer?.isModerator;
  const { rows } = await sql<HashCandidate>`
    WITH copies AS (
      SELECT
        mf.id AS "fileId",
        mf."modelVersionId",
        mf."sizeKB",
        mf.visibility,
        mf."pickleScanResult",
        mf."virusScanResult",
        mv.status AS "versionStatus",
        mv."publishedAt",
        mv."usageControl",
        mv."requireAuth",
        m."userId" AS "ownerId",
        m.status AS "modelStatus",
        m.mode,
        m.poi,
        (pa."entityId" IS NOT NULL AND (pa."endsAt" IS NULL OR pa."endsAt" > now())) AS paid,
        count(*) OVER () AS "groupSize",
        array_agg(mf.id) FILTER (
          WHERE m.status IN ('Deleted', 'UnpublishedViolation')
            OR m.mode = 'TakenDown'
            OR m."deletedAt" IS NOT NULL
        ) OVER () AS "takenDownFileIds",
        max(mf."sizeKB") OVER () - min(mf."sizeKB") OVER () AS "groupSizeSpreadKB"
      FROM "ModelFileHash" mfh
      JOIN "ModelFile" mf ON mf.id = mfh."fileId"
      JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      LEFT JOIN "PaidAccess" pa ON pa."entityType" = 'ModelVersion' AND pa."entityId" = mv.id
      WHERE mfh.hash = ${hash} AND mfh.type = ${DOWNLOAD_HASH_TYPES[kind]}
    ),
    viewed AS (
      SELECT c.*, COALESCE(c."ownerId" = ${userId}::int, false) AS owner FROM copies c
    ),
    live AS (
      SELECT
        v.*,
        count(*) OVER () AS "liveCount",
        max(v."sizeKB") OVER () - min(v."sizeKB") OVER () AS "liveSizeSpreadKB"
      FROM viewed v
      WHERE v.mode IS DISTINCT FROM 'Archived'
        AND (
          ${isMod}::boolean
          OR (
            v."modelStatus" <> 'Deleted'
            AND v."pickleScanResult" IS DISTINCT FROM 'Danger'
            AND v."virusScanResult" IS DISTINCT FROM 'Danger'
            AND (
              v.owner
              OR (
                NOT v.poi
                AND v."modelStatus" = 'Published'
                AND v."versionStatus" = 'Published'
                AND v."usageControl" = 'Download'
                AND v.visibility = 'Public'
              )
            )
          )
        )
    )
    SELECT
      "fileId",
      "modelVersionId",
      "groupSize"::int AS "groupSize",
      "liveCount"::int AS "liveCount",
      "takenDownFileIds",
      "groupSizeSpreadKB",
      "liveSizeSpreadKB"
    FROM live
    ORDER BY
      CASE
        WHEN owner THEN 0
        WHEN "modelStatus" = 'Published' AND "versionStatus" = 'Published'
          AND visibility = 'Public' AND NOT paid
          AND (NOT "requireAuth" OR ${userId}::int IS NOT NULL) THEN 1
        WHEN "modelStatus" = 'Published' AND "versionStatus" = 'Published' THEN 2
        ELSE 3
      END,
      "publishedAt" DESC NULLS LAST,
      "fileId"
    LIMIT ${MAX_HASH_CANDIDATES}
  `.execute(kyselyRead);
  return rows;
}

/**
 * When every candidate is refused, the most actionable refusal is the one returned: early access
 * keeps the purchase redirect, unauthorized keeps the login redirect.
 */
const REFUSAL_PRECEDENCE: GateStatus[] = [
  'early-access',
  'unauthorized',
  'no-access',
  'downloads-disabled',
  'failed-scan',
  'archived',
  'not-found',
];

function log(message: string, data: Record<string, unknown>) {
  logToAxiom({ name: 'download-by-hash', type: 'info', message, ...data }).catch(() => {
    // swallow logging failure
  });
}

/**
 * Serves the first candidate the unchanged per-file gate passes. A copy of the same bytes that was
 * taken down does not refuse the request; it is logged for review.
 */
export async function pickFileByHash({
  hash,
  kind,
  viewer,
  gate,
}: {
  hash: string;
  kind: DownloadHashKind;
  viewer?: Viewer;
  gate: HashGate;
}): Promise<{ fileResult: GateResult; modelVersionId?: number }> {
  const candidates = await findHashCandidates({ hash, kind, viewer });
  if (!candidates.length) return { fileResult: { status: 'not-found' } };

  const group = candidates[0];
  const context = { urlKind: kind, hash, groupSize: group.groupSize, liveCount: group.liveCount };
  if (group.liveSizeSpreadKB > SIZE_MISMATCH_TOLERANCE_KB) {
    log('hash_size_mismatch', { ...context, sizeSpreadKB: group.liveSizeSpreadKB });
    return { fileResult: { status: 'not-found' } };
  }

  let refusal: { fileResult: GateResult; modelVersionId: number } | undefined;
  for (const candidate of candidates) {
    const fileResult = await gate({
      modelVersionId: candidate.modelVersionId,
      fileId: candidate.fileId,
    });
    if (fileResult.status === 'success') {
      if (group.takenDownFileIds?.length)
        log('served_with_taken_down_copy', {
          ...context,
          servedFileId: candidate.fileId,
          takenDownFileIds: group.takenDownFileIds,
          sizeMismatch: group.groupSizeSpreadKB > SIZE_MISMATCH_TOLERANCE_KB,
        });
      return { fileResult, modelVersionId: candidate.modelVersionId };
    }
    // A storage failure is not a refusal: answer it now rather than repeat it on every copy.
    if (fileResult.status === 'resolve-failed' || fileResult.status === 'error')
      return { fileResult, modelVersionId: candidate.modelVersionId };

    const rank = REFUSAL_PRECEDENCE.indexOf(fileResult.status);
    if (!refusal || rank < REFUSAL_PRECEDENCE.indexOf(refusal.fileResult.status))
      refusal = { fileResult, modelVersionId: candidate.modelVersionId };
  }

  if (group.liveCount > candidates.length)
    log('capped_refusal', {
      ...context,
      tried: candidates.length,
      status: refusal?.fileResult.status,
    });
  return refusal ?? { fileResult: { status: 'not-found' } };
}

/** Reads `/api/download/<kind>/<hash>` for the shared download handler. */
export function hashDownloadRequest(kind: DownloadHashKind) {
  return (req: NextApiRequest): DownloadRequest => {
    const hash = parseContentHash(req.query.hash);
    if (!hash) return { ok: false, reason: 'invalid-hash' };
    return { ok: true, pick: (gate, viewer) => pickFileByHash({ hash, kind, viewer, gate }) };
  };
}
