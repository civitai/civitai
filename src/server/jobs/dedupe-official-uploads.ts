import { dbRead } from '~/server/db/client';
import { constants } from '~/server/common/constants';
import { addLinkedComponent } from '~/server/services/model-version.service';
import { inferComponentType } from '~/server/utils/model-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { logToAxiom } from '~/server/logging/client';
import { createJob, getJobDate } from './job';

const OFFICIAL_USER_ID = constants.system.officialUserId;
const CONCURRENCY = 10;
const BATCH_LIMIT = 1000;

export type DedupePair = {
  hostFileId: number;
  hostType: string;
  hostVersionId: number;
  canonicalFileId: number;
  canonicalVersionId: number;
  canonicalModelId: number;
  canonicalModelName: string;
  canonicalVersionName: string;
};

// Official files scanned since `since`, joined to every non-official published
// copy of the same SHA256 that isn't already linked. Canonical is NOT type-
// filtered (a standalone VAE's file is type='Model'); the host is.
export async function findOfficialDedupePairs(since: Date, limit: number): Promise<DedupePair[]> {
  return dbRead.$queryRaw<DedupePair[]>`
    WITH official_recent AS (
      SELECT mf.id AS canonical_file_id, mf."modelVersionId" AS canonical_version_id,
             mfh.hash, mv."modelId" AS canonical_model_id,
             m.name AS canonical_model_name, mv.name AS canonical_version_name
      FROM "ModelFile" mf
      JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id AND mfh.type = 'SHA256'
      JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE m."userId" = ${OFFICIAL_USER_ID} AND mf."scannedAt" >= ${since}
    ),
    canonical AS (
      SELECT DISTINCT ON (hash) hash, canonical_file_id, canonical_version_id,
             canonical_model_id, canonical_model_name, canonical_version_name
      FROM official_recent
      ORDER BY hash, canonical_version_id ASC
    )
    SELECT h.id                     AS "hostFileId",
           h.type                   AS "hostType",
           h."modelVersionId"       AS "hostVersionId",
           c.canonical_file_id      AS "canonicalFileId",
           c.canonical_version_id   AS "canonicalVersionId",
           c.canonical_model_id     AS "canonicalModelId",
           c.canonical_model_name   AS "canonicalModelName",
           c.canonical_version_name AS "canonicalVersionName"
    FROM canonical c
    JOIN "ModelFileHash" hh ON hh.hash = c.hash AND hh.type = 'SHA256'
    JOIN "ModelFile" h ON h.id = hh."fileId"
    JOIN "ModelVersion" hv ON hv.id = h."modelVersionId"
    JOIN "Model" hm ON hm.id = hv."modelId"
    WHERE hm."userId" <> ${OFFICIAL_USER_ID}
      AND hm.status = 'Published'
      AND h.type NOT IN ('Model', 'Pruned Model')
      AND h."modelVersionId" <> c.canonical_version_id
      AND NOT EXISTS (
        SELECT 1 FROM "RecommendedResource" rr
        WHERE rr."sourceId" = h."modelVersionId"
          AND rr."resourceId" = c.canonical_version_id
          AND rr.settings->>'isLinkedComponent' = 'true'
          AND (rr.settings->>'fileId')::int = c.canonical_file_id
      )
    ORDER BY h."modelVersionId", h.id
    LIMIT ${limit}
  `;
}

// Group by host version and run each group sequentially (parallel across
// groups): two host files on one version sharing a canonical would race the
// check-then-act dedupe in addLinkedComponent.
export async function processDedupePairs(pairs: DedupePair[], concurrency: number) {
  const byVersion = new Map<number, DedupePair[]>();
  for (const p of pairs) {
    const list = byVersion.get(p.hostVersionId) ?? [];
    list.push(p);
    byVersion.set(p.hostVersionId, list);
  }

  const groups = [...byVersion.values()].map((group) => async () => {
    for (const pair of group) {
      const componentType = inferComponentType(pair.hostType);
      if (!componentType) continue;
      try {
        await addLinkedComponent({
          id: pair.hostVersionId,
          targetVersionId: pair.canonicalVersionId,
          targetFileId: pair.canonicalFileId,
          replaceFileId: pair.hostFileId,
          componentType,
          modelId: pair.canonicalModelId,
          modelName: pair.canonicalModelName,
          versionName: pair.canonicalVersionName,
          isRequired: true,
          userId: OFFICIAL_USER_ID,
          isModerator: true,
        });
      } catch (e) {
        logToAxiom(
          {
            type: 'warning',
            name: 'b2-official-dedup',
            message: (e as Error).message,
            hostFileId: pair.hostFileId,
          },
          'webhooks'
        ).catch(() => null);
      }
    }
  });

  await limitConcurrency(groups, concurrency);
}

export const dedupeOfficialUploadsJob = createJob(
  'dedupe-official-uploads',
  '0 * * * *',
  async () => {
    // 1h overlap; the pointer dedupe in addLinkedComponent makes re-processing safe.
    const [lastRun, setLastRun] = await getJobDate('dedupe-official-uploads');
    const since = new Date(lastRun.getTime() - 60 * 60 * 1000);
    const pairs = await findOfficialDedupePairs(since, BATCH_LIMIT);
    await processDedupePairs(pairs, CONCURRENCY);
    await setLastRun();
    return { pairs: pairs.length };
  }
);
