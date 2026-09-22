import { chunk, uniq } from 'lodash-es';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { getLoadedResourceAirs } from '~/server/http/orchestrator/loaded-resources';
import { modelsSearchIndex } from '~/server/search-index';
import { versionIdFromAir } from '~/shared/utils/air';
import { createJob } from './job';

/** Ids per statement, so the first run does not lock or look up tens of thousands of rows at once. */
const BATCH = 5000;

type Version = { id: number; modelId: number };

async function findVersions(ids: number[]) {
  const found: Version[] = [];
  for (const batch of chunk(ids, BATCH))
    found.push(
      ...(await dbWrite.$queryRaw<Version[]>`
        SELECT id, "modelId" FROM "ModelVersion" WHERE id = ANY(${batch}::int[])
      `)
    );
  return found;
}

async function setLoaded(ids: number[], loaded: boolean) {
  // Raw SQL rather than updateMany: Prisma's @updatedAt would bump ModelVersion."updatedAt", which is
  // on the public v1 payload and is remove-old-drafts' activity fence.
  for (const batch of chunk(ids, BATCH))
    await dbWrite.$executeRaw`
      UPDATE "ModelVersion" SET "generatorLoaded" = ${loaded} WHERE id = ANY(${batch}::int[])
    `;
}

export const syncGeneratorLoadedResources = createJob(
  'sync-generator-loaded-resources',
  // Every run downloads the whole civitai resident list, uncompressed — the orchestrator ignores
  // Accept-Encoding. Weigh that before shortening the interval.
  '*/5 * * * *',
  async () => {
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.SYNC_GENERATOR_LOADED_RESOURCES)))
      return { skipped: 'flag off' };

    const airs = await getLoadedResourceAirs({ source: 'civitai' });
    if (!airs) return { skipped: 'orchestrator restarting' };
    const listed = new Set(airs.map(versionIdFromAir).filter((id): id is number => id != null));

    // An empty list is far likelier an orchestrator restart or an AIR format this parser misses than
    // a fleet with nothing loaded, and clearing on it would wipe every badge at once.
    if (!listed.size)
      throw new Error(
        `${airs.length} loaded resources resolved to no model versions; refusing to clear`
      );

    // Diffed here, not in SQL: joining the list makes the planner guess `unnest` yields 10 rows and
    // probe the table once per id. This read is index-only via ModelVersion_generatorLoaded_id_modelId_idx.
    const loaded = await dbWrite.$queryRaw<Version[]>`
      SELECT id, "modelId" FROM "ModelVersion" WHERE "generatorLoaded"
    `;
    const loadedIds = new Set(loaded.map((v) => v.id));

    const toUnload = loaded.filter((v) => !listed.has(v.id));
    const toLoad = await findVersions([...listed].filter((id) => !loadedIds.has(id)));

    await setLoaded(
      toLoad.map((v) => v.id),
      true
    );
    await setLoaded(
      toUnload.map((v) => v.id),
      false
    );

    // Only after the writes: a models sync draining the queue mid-write would index the old value,
    // and once written these rows match the list, so no later run queues them again. Nothing touches
    // the parent Model's updatedAt either — the index's delta scan would re-pull them every cycle.
    const modelIds = uniq([...toLoad, ...toUnload].map((v) => v.modelId));
    if (modelIds.length)
      await modelsSearchIndex.queueUpdate(
        modelIds.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
      );

    return {
      airs: airs.length,
      listed: listed.size,
      loaded: loaded.length,
      flippedIn: toLoad.length,
      flippedOut: toUnload.length,
      queued: modelIds.length,
    };
  }
);
