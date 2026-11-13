import type { Prisma } from '@prisma/client';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { getModelsWithVersionsStatsRow } from '@civitai/db-queries/hot-reads-11';
import { dbRead } from '~/server/db/client';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { createCachedFlagGate, readFliptSwitch } from '~/server/utils/otel-withspan-gate';

/**
 * The reads behind `kysely-hot-reads-11`: the four per-page reads of `getModelsWithVersions`
 * (model.service.ts, behind the public /api/v1/models list and /api/v1/models/:id), as a Prisma
 * reader and its Kysely twin taking the client, so the parity suite
 * (__tests__/hot-reads-11.kysely-parity.test.ts) runs the very code the service runs. The Prisma
 * reader is the original four reads, moved here verbatim and issued one after another as before.
 * The twin returns the same rows from ONE statement where Prisma issues four.
 */

/** The page's ids: every model on the page, and every version of those models. */
export type ModelsWithVersionsIds = { modelIds: number[]; modelVersionIds: number[] };

/**
 * What `getModelsWithVersions` reads from the four results: these keys and no others. Both
 * readers return this type, so a caller that starts reading another column fails to compile until
 * the Kysely statement selects it too. (The Prisma metric reads have no `select`, so at runtime
 * their rows carry every column; the type hides the rest.)
 */
export type ModelsWithVersionsStats = {
  /** Linked components of the versions (`settings.isLinkedComponent === true`). */
  vaeLinkedRows: { sourceId: number | null; resourceId: number; settings: Prisma.JsonValue }[];
  metrics: {
    modelId: number;
    downloadCount: number;
    thumbsUpCount: number;
    thumbsDownCount: number;
    commentCount: number;
    tippedAmountCount: number;
  }[];
  versionMetrics: {
    modelVersionId: number;
    downloadCount: number;
    thumbsUpCount: number;
    thumbsDownCount: number;
  }[];
  versionMetaRows: { id: number; meta: Prisma.JsonValue }[];
};

/** The original four reads, verbatim: four statements (two when there are no versions). */
export async function readModelsWithVersionsStatsViaPrisma(
  db: Prisma.TransactionClient,
  { modelIds, modelVersionIds }: ModelsWithVersionsIds
): Promise<ModelsWithVersionsStats> {
  const vaeLinkedRows = modelVersionIds.length
    ? await db.recommendedResource.findMany({
        where: {
          sourceId: { in: modelVersionIds },
          settings: { path: ['isLinkedComponent'], equals: true },
        },
        select: { sourceId: true, resourceId: true, settings: true },
      })
    : [];

  const metrics = await db.modelMetric.findMany({
    where: { modelId: { in: modelIds } },
  });

  const versionMetrics = await db.modelVersionMetric.findMany({
    where: { modelVersionId: { in: modelVersionIds } },
  });

  const versionMetaRows = modelVersionIds.length
    ? await db.modelVersion.findMany({
        where: { id: { in: modelVersionIds } },
        select: { id: true, meta: true },
      })
    : [];

  return { vaeLinkedRows, metrics, versionMetrics, versionMetaRows };
}

/**
 * The same rows from ONE statement (`getModelsWithVersionsStatsRow`). With no ids at all it answers
 * without a statement: every Prisma read is then empty too.
 */
export async function readModelsWithVersionsStatsViaKysely(
  db: Kysely<DB>,
  ids: ModelsWithVersionsIds
): Promise<ModelsWithVersionsStats> {
  if (!ids.modelIds.length && !ids.modelVersionIds.length)
    return { vaeLinkedRows: [], metrics: [], versionMetrics: [], versionMetaRows: [] };
  const row = await getModelsWithVersionsStatsRow(db, ids);
  return {
    vaeLinkedRows: row.vaeLinks as ModelsWithVersionsStats['vaeLinkedRows'],
    // A scalar subquery is typed nullable; `coalesce(…, '[]')` means it never is at runtime.
    metrics: row.modelMetrics ?? [],
    versionMetrics: row.versionMetrics ?? [],
    versionMetaRows: row.versionMeta as ModelsWithVersionsStats['versionMetaRows'],
  };
}

const readFlag = readFliptSwitch(() => FLIPT_FEATURE_FLAGS.KYSELY_HOT_READS_11);
let kyselyHotReads11 = createCachedFlagGate(readFlag);

/** Tests only: forget the cached flag read. */
export function resetHotReads11GateForTests() {
  kyselyHotReads11 = createCachedFlagGate(readFlag);
}

/**
 * The four reads on the replica, as the Prisma reads always were: through Prisma while
 * `kysely-hot-reads-11` is off, through the one Kysely statement while it is on. The flag is read
 * once per call, from a per-process copy refreshed at most every few seconds.
 */
export async function readModelsWithVersionsStats(
  ids: ModelsWithVersionsIds
): Promise<ModelsWithVersionsStats> {
  if (kyselyHotReads11())
    return readModelsWithVersionsStatsViaKysely((await loadKyselyDb()).kyselyRead, ids);
  return readModelsWithVersionsStatsViaPrisma(dbRead, ids);
}
