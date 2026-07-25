import { dbRead } from '~/server/db/client';

/**
 * Batched, index-only replacement for a per-row Prisma `_count.modelVersions`
 * include.
 *
 * Prisma compiles `_count: { select: { modelVersions: true } }` into a LEFT JOIN
 * against a subquery that GROUPs the ENTIRE `ModelVersion` table — Postgres does
 * NOT push the `Model.id IN (...)` filter into that grouped derived table, so it
 * aggregates all ~1.17M rows (~909k groups, ~1.2M shared buffers, ~1344ms) just
 * to attach a version count to the handful of requested models.
 *
 * The pushed-down equivalent — `SELECT "modelId", COUNT(*) FROM "ModelVersion"
 * WHERE "modelId" IN (<ids>) GROUP BY "modelId"` — DOES push the filter into the
 * aggregate and is index-only on the existing `ModelVersion_modelId_baseModel_idx`
 * (no new index), ~1.5ms EXPLAIN-verified against the read replica (~900x faster).
 *
 * Semantics match the unfiltered `_count` it replaces: it counts ALL
 * modelVersions for each model. The returned map is DENSE over the requested ids
 * — models with zero versions (absent from the GROUP BY result) are still keyed
 * with a count of 0, so callers can attach a byte-identical
 * `_count.modelVersions` number without a separate coalesce.
 */
export const getModelVersionCountsByModelId = async (
  modelIds: number[]
): Promise<Map<number, number>> => {
  const ids = [...new Set(modelIds)];
  // Zero-fill so every requested model gets a number, including those with no
  // versions (which the GROUP BY omits entirely).
  const counts = new Map<number, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) return counts;

  const grouped = await dbRead.modelVersion.groupBy({
    by: ['modelId'],
    where: { modelId: { in: ids } },
    _count: { _all: true },
  });

  for (const row of grouped) {
    counts.set(row.modelId, row._count._all);
  }

  return counts;
};
