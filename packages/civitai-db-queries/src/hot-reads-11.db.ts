import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { jsonBuildObject } from './infra/helpers';

// The Kysely port of the four per-page reads in `getModelsWithVersions` (model.service.ts, behind
// the public /api/v1/models list and /api/v1/models/:id), served behind the default-off server
// Flipt flag `kysely-hot-reads-11`; off, the Prisma reads run unchanged. Prisma issues one
// statement per read: the versions' linked components ("RecommendedResource"), the models'
// metrics ("ModelMetric"), the versions' metrics ("ModelVersionMetric") and the versions' `meta`
// ("ModelVersion"). They depend only on the page's model and version ids, not on each other, so
// this is ONE statement with four uncorrelated `json_agg` subqueries. The app-side wrapper
// (<civitai>/src/server/services/hot-reads-11.reads.ts) returns them as the four lists, and
// <civitai>/src/server/services/__tests__/hot-reads-11.kysely-parity.test.ts compares the two
// paths against a real database.
//
// Shape notes, each pinned by the parity suite:
// - Only the columns the caller reads are selected. The Prisma metric reads have no `select`, so
//   they return every column; the caller reads five model and three version counters, and the
//   wrapper's return type is that narrow shape on BOTH paths, so a caller that starts reading
//   another column fails to compile until this statement carries it.
// - Every selected column survives JSON unchanged: integers, and the JSON columns "settings" and
//   "meta" (jsonb, embedded as values). None is a timestamp.
// - The id lists are ONE array parameter each (`= ANY($n)`), so an empty list matches nothing
//   instead of being a syntax error, and the statement text does not vary with the page size.
// - The linked-component filter is Prisma's `settings: { path: ['isLinkedComponent'], equals: true }`:
//   the value at that path must be the JSON `true` (not the string "true"); a NULL "settings"
//   matches nothing.
// - None of the Prisma reads has an `orderBy`. Every aggregate here is ordered by its table's key.
//   Only the linked-component order can matter to the caller (it keeps the LAST VAE row per
//   version). That order is NOT guaranteed equal: Prisma's unordered read follows heap order,
//   which is key order only until a row is UPDATEd (an update moves it), so for a version with
//   several linked VAE rows the OFF path's pick is arbitrary and this path's is the highest id.
//
// Relations: base tables only, none declared `/// @view`.

/** One linked-component row as the aggregate builds it. */
export type ModelsWithVersionsVaeLinkJson = {
  sourceId: number | null;
  resourceId: number;
  settings: unknown;
};

/** One model's counters as the aggregate builds them. */
export type ModelsWithVersionsModelMetricJson = {
  modelId: number;
  downloadCount: number;
  thumbsUpCount: number;
  thumbsDownCount: number;
  commentCount: number;
  tippedAmountCount: number;
};

/** One version's counters as the aggregate builds them. */
export type ModelsWithVersionsVersionMetricJson = {
  modelVersionId: number;
  downloadCount: number;
  thumbsUpCount: number;
  thumbsDownCount: number;
};

/** One version's `meta` as the aggregate builds it. */
export type ModelsWithVersionsVersionMetaJson = { id: number; meta: unknown };

/**
 * The linked components of `modelVersionIds`, the metrics of `modelIds` and `modelVersionIds`, and
 * the `meta` of `modelVersionIds`, as four JSON arrays from one statement.
 */
export function getModelsWithVersionsStatsRow(
  db: Kysely<DB>,
  { modelIds, modelVersionIds }: { modelIds: number[]; modelVersionIds: number[] }
) {
  return db
    .selectNoFrom((eb) => [
      eb
        .selectFrom('RecommendedResource')
        .select((eb) =>
          eb.fn
            .coalesce(
              eb.fn
                .jsonAgg(
                  jsonBuildObject({
                    sourceId: eb.ref('RecommendedResource.sourceId'),
                    resourceId: eb.ref('RecommendedResource.resourceId'),
                    settings: eb.ref('RecommendedResource.settings'),
                  })
                )
                .orderBy('RecommendedResource.id', 'asc'),
              sql<[]>`'[]'`
            )
            .as('vaeLinks')
        )
        .where('RecommendedResource.sourceId', '=', eb.fn.any(eb.val(modelVersionIds)))
        .where(
          sql<boolean>`${sql.ref(
            'RecommendedResource.settings'
          )} #> '{isLinkedComponent}' = 'true'::jsonb`
        )
        .$castTo<{ vaeLinks: ModelsWithVersionsVaeLinkJson[] }>()
        .as('vaeLinks'),
      eb
        .selectFrom('ModelMetric')
        .select((eb) =>
          eb.fn
            .coalesce(
              eb.fn
                .jsonAgg(
                  jsonBuildObject({
                    modelId: eb.ref('ModelMetric.modelId'),
                    downloadCount: eb.ref('ModelMetric.downloadCount'),
                    thumbsUpCount: eb.ref('ModelMetric.thumbsUpCount'),
                    thumbsDownCount: eb.ref('ModelMetric.thumbsDownCount'),
                    commentCount: eb.ref('ModelMetric.commentCount'),
                    tippedAmountCount: eb.ref('ModelMetric.tippedAmountCount'),
                  })
                )
                .orderBy('ModelMetric.modelId', 'asc'),
              sql<[]>`'[]'`
            )
            .as('modelMetrics')
        )
        .where('ModelMetric.modelId', '=', eb.fn.any(eb.val(modelIds)))
        .$castTo<{ modelMetrics: ModelsWithVersionsModelMetricJson[] }>()
        .as('modelMetrics'),
      eb
        .selectFrom('ModelVersionMetric')
        .select((eb) =>
          eb.fn
            .coalesce(
              eb.fn
                .jsonAgg(
                  jsonBuildObject({
                    modelVersionId: eb.ref('ModelVersionMetric.modelVersionId'),
                    downloadCount: eb.ref('ModelVersionMetric.downloadCount'),
                    thumbsUpCount: eb.ref('ModelVersionMetric.thumbsUpCount'),
                    thumbsDownCount: eb.ref('ModelVersionMetric.thumbsDownCount'),
                  })
                )
                .orderBy('ModelVersionMetric.modelVersionId', 'asc'),
              sql<[]>`'[]'`
            )
            .as('versionMetrics')
        )
        .where('ModelVersionMetric.modelVersionId', '=', eb.fn.any(eb.val(modelVersionIds)))
        .$castTo<{ versionMetrics: ModelsWithVersionsVersionMetricJson[] }>()
        .as('versionMetrics'),
      eb
        .selectFrom('ModelVersion')
        .select((eb) =>
          eb.fn
            .coalesce(
              eb.fn
                .jsonAgg(
                  jsonBuildObject({
                    id: eb.ref('ModelVersion.id'),
                    meta: eb.ref('ModelVersion.meta'),
                  })
                )
                .orderBy('ModelVersion.id', 'asc'),
              sql<[]>`'[]'`
            )
            .as('versionMeta')
        )
        .where('ModelVersion.id', '=', eb.fn.any(eb.val(modelVersionIds)))
        .$castTo<{ versionMeta: ModelsWithVersionsVersionMetaJson[] }>()
        .as('versionMeta'),
    ])
    .executeTakeFirstOrThrow();
}
