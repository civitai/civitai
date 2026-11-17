import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

/**
 * Rollup drift on mature models (`Model.nsfw = true`): the version rollup stamps every version of
 * one at the mature level, which has no safe (PG / PG-13) bit, so a version that still carries one
 * was never recomputed. A mature model's own level carries a safe bit only from a complete
 * civitai.com face's cover, so one with no face and a safe bit is drift too. The model rollup only
 * reaches a model with a Published version, so only those are counted: a recompute heals them.
 */
const matureVersionWithSafeBit = Prisma.sql`
  m.status = 'Published'
  AND mv.status = 'Published'
  AND m.nsfw
  AND (mv."nsfwLevel" & ${sfwBrowsingLevelsFlag}) != 0`;

const matureModelWithSafeBit = Prisma.sql`
  m.status = 'Published'
  AND m.nsfw
  AND m."sfwName" IS NULL
  AND (m."nsfwLevel" & ${sfwBrowsingLevelsFlag}) != 0
  AND EXISTS (
    SELECT 1 FROM "ModelVersion" pv WHERE pv."modelId" = m.id AND pv.status = 'Published'
  )`;

/** Above this many drifted rows at once, something is producing them: queue nothing. */
export const MATURE_SAFE_BIT_DRIFT_CAP = 500;

export async function countMatureSafeBitDrift(modelId?: number) {
  const modelFilter = modelId ? Prisma.sql`AND m.id = ${modelId}` : Prisma.empty;
  const [row] = await dbRead.$queryRaw<{ versionCount: bigint; modelCount: bigint }[]>(Prisma.sql`
    SELECT
      (
        SELECT count(*) FROM "ModelVersion" mv JOIN "Model" m ON m.id = mv."modelId"
        WHERE ${matureVersionWithSafeBit} ${modelFilter}
      ) AS "versionCount",
      (
        SELECT count(*) FROM "Model" m WHERE ${matureModelWithSafeBit} ${modelFilter}
      ) AS "modelCount"
  `);
  return { versionCount: Number(row?.versionCount ?? 0), modelCount: Number(row?.modelCount ?? 0) };
}

/**
 * Queue a level recompute for every drifted version and model, through the same JobQueue rows the
 * Model trigger writes (a version's job also recomputes its model, after the version). Queues
 * nothing when the drift is over `MATURE_SAFE_BIT_DRIFT_CAP` rows.
 */
export async function enqueueMatureSafeBitDrift(modelId?: number) {
  const counts = await countMatureSafeBitDrift(modelId);
  if (counts.versionCount + counts.modelCount > MATURE_SAFE_BIT_DRIFT_CAP)
    return { ...counts, overCap: true, enqueuedVersions: 0, enqueuedModels: 0 };

  const modelFilter = modelId ? Prisma.sql`AND m.id = ${modelId}` : Prisma.empty;
  const enqueuedVersions = await dbWrite.$executeRaw(Prisma.sql`
    INSERT INTO "JobQueue" ("entityId", "entityType", "type")
    SELECT mv.id, 'ModelVersion'::"EntityType", 'UpdateNsfwLevel'::"JobQueueType"
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE ${matureVersionWithSafeBit} ${modelFilter}
    ON CONFLICT DO NOTHING
  `);
  const enqueuedModels = await dbWrite.$executeRaw(Prisma.sql`
    INSERT INTO "JobQueue" ("entityId", "entityType", "type")
    SELECT m.id, 'Model'::"EntityType", 'UpdateNsfwLevel'::"JobQueueType"
    FROM "Model" m
    WHERE ${matureModelWithSafeBit} ${modelFilter}
    ON CONFLICT DO NOTHING
  `);
  return { ...counts, overCap: false, enqueuedVersions, enqueuedModels };
}
