import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import type { ResourceLoadAvailability } from '~/server/schema/resource-load.schema';
import { resourceAvailabilitySchema } from '~/server/schema/resource-load.schema';
import { getModelClient } from '~/server/services/orchestrator/models';
import { createCachedObject } from '~/server/utils/cache-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import {
  modelVersionAirSelect,
  modelVersionToAir,
  type GenerationFileCandidate,
} from '~/server/utils/resource-air';
import { generatorReadiness } from '~/shared/generation/generator-readiness';
import type { ModelType } from '~/shared/utils/prisma/enums';

/**
 * A file the cluster can serve as weights. Types mirror the coverage view minus its
 * `trainingResults` disjunct — a training archive is not a weight.
 */
export const LOADABLE_FILE_TYPES = [
  'Model',
  'Pruned Model',
  'Diffusion Model',
  'UNet',
  'Negative',
  'VAE',
];

/** Each state fetch is an orchestrator grain call, so keep the fan-out bounded. */
export const STATE_FETCH_CONCURRENCY = 10;

export type VersionForAir = {
  id: number;
  name: string;
  usageControl?: string | null;
  baseModel: string;
  flags: number;
  model: { id: number; name: string; type: ModelType };
  files: (GenerationFileCandidate & { scannedAt: Date | null })[];
};

export async function getVersionsForAir(modelVersionIds: number[]) {
  return (await dbRead.modelVersion.findMany({
    where: { id: { in: modelVersionIds } },
    select: {
      ...modelVersionAirSelect,
      name: true,
      flags: true,
      usageControl: true,
      model: { select: { ...modelVersionAirSelect.model.select, name: true } },
      files: { select: { ...modelVersionAirSelect.files.select, scannedAt: true } },
    },
  })) as VersionForAir[];
}

export function parseAvailability(availability: unknown): ResourceLoadAvailability {
  const parsed = resourceAvailabilitySchema.safeParse(availability);
  return parsed.success ? parsed.data : { status: 'unknown' };
}

const RESIDENCY_CACHE_SECONDS = 30;

export type ResourceResidency = {
  modelVersionId: number;
  availability: ResourceLoadAvailability;
  /** Bytes. Absent when the resource is unknown to the orchestrator. */
  size?: number;
};

/** One orchestrator grain call per version — the cache's lookup. */
async function fetchResourceResidency(modelVersionIds: number[]) {
  const versions = await getVersionsForAir(modelVersionIds);

  const entries: Record<number, ResourceResidency> = {};
  const tasks = versions.map((version) => async () => {
    if (generatorReadiness(version) === 'external') {
      entries[version.id] = { modelVersionId: version.id, availability: { status: 'external' } };
      return;
    }
    const response = await getModelClient({
      token: env.ORCHESTRATOR_ACCESS_TOKEN,
      air: modelVersionToAir(version),
    });
    entries[version.id] = {
      modelVersionId: version.id,
      availability: parseAvailability(response?.data?.availability),
      size: response?.data?.size,
    };
  });

  await limitConcurrency(tasks, STATE_FETCH_CONCURRENCY);
  return entries;
}

function createResourceResidencyCache() {
  return createCachedObject<ResourceResidency>({
    key: REDIS_KEYS.CACHES.RESOURCE_LOAD_RESIDENCY,
    idKey: 'modelVersionId',
    ttl: RESIDENCY_CACHE_SECONDS,
    // A hard miss takes no lock, and a popular checkpoint is asked for by every concurrent submit
    // naming it — so serve the expiring answer while one caller refreshes it.
    staleWhileRevalidate: true,
    lookupFn: (ids) => fetchResourceResidency(Array.isArray(ids) ? ids : [ids]),
  });
}

// Built on first use, not on import: an eager cache fails every suite that wholesale-mocks redis or
// cache-helpers at collection. See `no-module-scope-cache`.
let residencyCacheInstance: ReturnType<typeof createResourceResidencyCache> | undefined;
function resourceResidencyCache() {
  return (residencyCacheInstance ??= createResourceResidencyCache());
}

export async function bustResourceResidency(modelVersionIds: number[]) {
  // Under staleWhileRevalidate a bust only backdates the entry, by default to leave it fresh for the
  // debounce window — serving the pre-change answer longer than not busting at all. Zero makes the
  // next read refresh it behind the lock.
  if (modelVersionIds.length)
    await resourceResidencyCache().bust(modelVersionIds, { debounceTime: 0 });
}

export async function getResourceResidency(
  modelVersionIds: number[]
): Promise<ResourceResidency[]> {
  const cached = await resourceResidencyCache().fetch([...new Set(modelVersionIds)]);
  return Object.values(cached);
}

/**
 * The same answer uncached, for a waiting generation's own few models: the shared cache can hold a
 * pre-queue `unavailable` for its whole TTL, which is exactly when the queue card needs a fresh one.
 */
export async function getLiveResourceResidency(
  modelVersionIds: number[]
): Promise<ResourceResidency[]> {
  return Object.values(await fetchResourceResidency([...new Set(modelVersionIds)]));
}
