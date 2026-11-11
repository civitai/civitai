import type { NextApiRequest } from 'next';
import { sql } from 'kysely';
import type { DownloadRequest } from '~/pages/api/download/models/[modelVersionId]';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { logToAxiom } from '~/server/logging/client';
import type { getFileForModelVersion } from '~/server/services/file.service';
import type {
  GenerationFetchRefusal,
  GenerationFetchResult,
} from '~/server/services/download-link/generation-fetch.service';
import { PROVIDER_FETCHABLE_STATUSES } from '~/server/services/download-link/provider-fetchable';

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
/** A per-provider download token's holder: offered what `checkGenerationFetch` serves a provider. */
type ProviderViewer = { provider: string };

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
 * Copies of the content the gate could pass for this viewer, likeliest first; the oldest copy wins
 * within a tier so a re-upload never takes the original's downloads. Private copies are left out
 * for everyone but their owner, moderators and providers, so a refusal cannot confirm a private
 * model holds these bytes. The gate still decides every candidate.
 */
export async function findHashCandidates({
  hash,
  kind,
  viewer,
}: {
  hash: string;
  kind: DownloadHashKind;
  viewer?: Viewer | ProviderViewer;
}): Promise<HashCandidate[]> {
  const { kyselyRead } = await loadKyselyDb();
  const isProvider = !!viewer && 'provider' in viewer;
  const userId = (!isProvider && viewer?.id) || null;
  const isMod = !isProvider && !!viewer?.isModerator;
  const { rows } = await sql<HashCandidate>`
    WITH copies AS (
      SELECT
        mf.id AS "fileId",
        mf."modelVersionId",
        mf."sizeKB",
        mf.type AS "fileType",
        mf.visibility,
        mf."pickleScanResult",
        mf."virusScanResult",
        mv.status AS "versionStatus",
        mv."publishedAt",
        mv."usageControl",
        mv."requireAuth",
        (mv.availability = 'Private' OR m.availability = 'Private') AS private,
        m."userId" AS "ownerId",
        m.status AS "modelStatus",
        m."deletedAt" AS "modelDeletedAt",
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
        AND CASE
          -- Mirrors checkGenerationFetch's refusals for a provider principal.
          WHEN ${isProvider}::boolean THEN
            v.mode IS DISTINCT FROM 'TakenDown'
            AND v."modelDeletedAt" IS NULL
            AND v."modelStatus"::text IN (${sql.join([...PROVIDER_FETCHABLE_STATUSES])})
            AND v."versionStatus"::text IN (${sql.join([...PROVIDER_FETCHABLE_STATUSES])})
            AND NOT v.poi
            AND v."pickleScanResult" IS DISTINCT FROM 'Danger'
            AND v."virusScanResult" IS DISTINCT FROM 'Danger'
            AND v."fileType" <> 'Training Data'
          ELSE
            ${isMod}::boolean
            OR (
              v."modelStatus" <> 'Deleted'
              AND v.mode IS DISTINCT FROM 'TakenDown'
              AND v."pickleScanResult" IS DISTINCT FROM 'Danger'
              AND v."virusScanResult" IS DISTINCT FROM 'Danger'
              AND (
                v.owner
                OR (
                  -- Mirrors canViewPoiModel and isPrivateModelVersion (model-visibility.service).
                  NOT v.poi
                  AND NOT v.private
                  AND v."modelStatus" = 'Published'
                  AND v."versionStatus" = 'Published'
                  AND v."usageControl" = 'Download'
                  AND v.visibility = 'Public'
                )
              )
            )
        END
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
      "publishedAt" ASC NULLS LAST,
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
  'resolve-failed',
  'error',
  'not-found',
];

/** A provider's refusals, most specific first, so a copy in review is not reported as missing. */
const PROVIDER_REFUSAL_PRECEDENCE: GenerationFetchRefusal[] = [
  'in-review',
  'failed-scan',
  'archived',
  'poi',
  'early-access',
  'unauthorized',
  'no-access',
  'no-generation',
  'unsupported-file',
  'not-found',
];

function log(message: string, data: Record<string, unknown>) {
  logToAxiom({ name: 'download-by-hash', type: 'info', message, ...data }).catch(() => {
    // swallow logging failure
  });
}

/**
 * Runs the candidates through `attempt` and returns the first it serves. A copy of the same bytes
 * that was taken down does not refuse the request; it is logged for review.
 */
async function firstServedCandidate<R>({
  hash,
  kind,
  viewer,
  attempt,
  status,
  precedence,
  notFound,
}: {
  hash: string;
  kind: DownloadHashKind;
  viewer?: Viewer | ProviderViewer;
  attempt: (candidate: HashCandidate) => Promise<R>;
  /** `success`, or the refusal's name in `precedence`. */
  status: (result: R) => string;
  precedence: readonly string[];
  notFound: R;
}): Promise<{ result: R; modelVersionId?: number }> {
  const candidates = await findHashCandidates({ hash, kind, viewer });
  if (!candidates.length) return { result: notFound };

  const group = candidates[0];
  const context = {
    urlKind: kind,
    provider: viewer && 'provider' in viewer ? viewer.provider : undefined,
    hash,
    groupSize: group.groupSize,
    liveCount: group.liveCount,
  };
  if (group.liveSizeSpreadKB > SIZE_MISMATCH_TOLERANCE_KB) {
    log('hash_size_mismatch', { ...context, sizeSpreadKB: group.liveSizeSpreadKB });
    return { result: notFound };
  }

  let refusal: { result: R; modelVersionId: number } | undefined;
  for (const candidate of candidates) {
    const result = await attempt(candidate);
    if (status(result) === 'success') {
      if (group.takenDownFileIds?.length)
        log('served_with_taken_down_copy', {
          ...context,
          servedFileId: candidate.fileId,
          takenDownFileIds: group.takenDownFileIds,
          sizeMismatch: group.groupSizeSpreadKB > SIZE_MISMATCH_TOLERANCE_KB,
        });
      return { result, modelVersionId: candidate.modelVersionId };
    }
    const rank = precedence.indexOf(status(result));
    if (!refusal || rank < precedence.indexOf(status(refusal.result)))
      refusal = { result, modelVersionId: candidate.modelVersionId };
  }

  if (group.liveCount > candidates.length)
    log('capped_refusal', {
      ...context,
      tried: candidates.length,
      status: refusal && status(refusal.result),
    });
  return refusal ?? { result: notFound };
}

/** Serves the first candidate the per-file download gate passes for this viewer. */
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
  const { result, modelVersionId } = await firstServedCandidate<GateResult>({
    hash,
    kind,
    viewer,
    attempt: ({ modelVersionId, fileId }) => gate({ modelVersionId, fileId }),
    status: (fileResult) => fileResult.status,
    precedence: REFUSAL_PRECEDENCE,
    notFound: { status: 'not-found' },
  });
  return { fileResult: result, modelVersionId };
}

export type ProviderHashGate = (args: {
  modelVersionId: number;
  fileId: number;
}) => Promise<GenerationFetchResult>;

/** Serves a provider the first candidate `checkGenerationFetch` passes for it. */
export async function pickProviderFileByHash({
  hash,
  kind,
  provider,
  gate,
}: {
  hash: string;
  kind: DownloadHashKind;
  provider: string;
  gate: ProviderHashGate;
}): Promise<GenerationFetchResult> {
  const { result } = await firstServedCandidate<GenerationFetchResult>({
    hash,
    kind,
    viewer: { provider },
    attempt: ({ modelVersionId, fileId }) => gate({ modelVersionId, fileId }),
    status: (check) => (check.ok ? 'success' : check.error),
    precedence: PROVIDER_REFUSAL_PRECEDENCE,
    notFound: { ok: false, error: 'not-found' },
  });
  return result;
}

/** Reads `/api/download/<kind>/<hash>` for the shared download handler. */
export function hashDownloadRequest(kind: DownloadHashKind) {
  return (req: NextApiRequest): DownloadRequest => {
    const hash = parseContentHash(req.query.hash);
    if (!hash) return { ok: false, reason: 'invalid-hash' };
    return {
      ok: true,
      pick: (gate, viewer) => pickFileByHash({ hash, kind, viewer, gate }),
      async providerPick({ req, res, provider }) {
        // Loaded only for a provider token, as the handler loads the token check.
        const [{ checkGenerationFetch }, { serveProviderFetch }] = await Promise.all([
          import('~/server/services/download-link/generation-fetch.service'),
          import('~/server/services/provider-download/provider-download.service'),
        ]);
        const check = await pickProviderFileByHash({
          hash,
          kind,
          provider,
          gate: ({ modelVersionId, fileId }) =>
            checkGenerationFetch({
              modelVersionId,
              fileId,
              principal: { kind: 'provider', provider },
            }),
        });
        return serveProviderFetch({ req, res, provider, check });
      },
    };
  };
}
