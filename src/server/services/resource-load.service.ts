import { Prisma } from '@prisma/client';
import { isGenerationEligible } from '@civitai/shared/generation-eligibility';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { getResourceLoadCallbacks } from '~/server/orchestrator/orchestrator.utils';
import type {
  GetResourceLoadQueueInput,
  ResourceLoadAvailability,
} from '~/server/schema/resource-load.schema';
import {
  resourceAvailabilitySchema,
  UNLOADABLE_MESSAGES,
} from '~/server/schema/resource-load.schema';
import type { UnloadableReason } from '~/server/schema/resource-load.schema';
import { assertWorkflowOwner } from '~/server/services/orchestrator/assert-workflow-owner';
import {
  coveredForUserSql,
  nextCoverageEnabled,
} from '~/server/services/generation/coverage-source';
import { generatorReadiness } from '~/shared/generation/generator-readiness';
import { getModelClient, queryResourcesClient } from '~/server/services/orchestrator/models';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { createCachedObject } from '~/server/utils/cache-helpers';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { modelVersionToAir } from '~/server/utils/resource-air';
import { versionIdFromAir } from '~/shared/utils/air';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { BuzzTypes } from '~/shared/constants/buzz.constants';

const PREPARE_STEP_NAME = 'prepare-resource';

/**
 * A file the cluster can serve as weights. Types mirror the coverage view minus its
 * `trainingResults` disjunct — a training archive is not a weight.
 *
 * Format is an allow-list because `format` is free text and frequently unset; a deny-list cannot
 * promise the loader only ever sees SafeTensor.
 */
const LOADABLE_FILE_TYPES = ['Model', 'Pruned Model', 'Diffusion Model', 'UNet', 'Negative', 'VAE'];
const LOADABLE_FORMAT = 'SafeTensor';

function checkLoadable(
  files: VersionForAir['files'],
  modelType: ModelType
): { loadable: true } | { loadable: false; unloadableReason: UnloadableReason } {
  const weights = files.filter((f) => !!f.scannedAt && LOADABLE_FILE_TYPES.includes(f.type));
  if (!weights.length) return { loadable: false, unloadableReason: 'no-weights' };
  // Scoped to checkpoints to match the coverage view's checkpoint disjunct. Applying it to every
  // type would refuse the PickleTensor embeddings and LoRAs the view deliberately keeps covered.
  if (modelType === 'Checkpoint' && !weights.some((f) => f.metadata?.format === LOADABLE_FORMAT))
    return { loadable: false, unloadableReason: 'unsupported-format' };
  return { loadable: true };
}

/** Each state fetch is an orchestrator grain call, so keep the fan-out bounded. */
const STATE_FETCH_CONCURRENCY = 10;

export type ResourceLoadState = {
  modelVersionId: number;
  modelId: number;
  air: string;
  name: string;
  modelName: string;
  /** Bytes, as the orchestrator reports it. Absent when the resource is unknown to it. */
  size?: number;
  availability: ResourceLoadAvailability;
  /** Coverage alone over-reports; see docs/features/paid-model-loading-coverage.md. */
  eligible: boolean;
  /** Whether the cluster can serve this version's weights. */
  loadable: boolean;
  /** Why not, when `loadable` is false — so a CTA can say so without re-deriving it. */
  unloadableReason?: UnloadableReason;
};

type VersionForAir = {
  id: number;
  name: string;
  usageControl?: string | null;
  baseModel: string;
  flags: number;
  model: { id: number; name: string; type: ModelType };
  files: { type: string; scannedAt: Date | null; metadata: BasicFileMetadata }[];
};

async function getVersionsForAir(modelVersionIds: number[]) {
  return (await dbRead.modelVersion.findMany({
    where: { id: { in: modelVersionIds } },
    select: {
      id: true,
      name: true,
      baseModel: true,
      flags: true,
      usageControl: true,
      model: { select: { id: true, name: true, type: true } },
      files: { select: { type: true, scannedAt: true, metadata: true } },
    },
  })) as VersionForAir[];
}

async function getCoveredVersionIds(
  modelVersionIds: number[],
  audience: { next: boolean; member: boolean }
) {
  if (!modelVersionIds.length) return new Set<number>();
  const covered = coveredForUserSql(audience);
  const rows = await dbRead.$queryRaw<{ modelVersionId: number }[]>`
    SELECT "modelVersionId" FROM "GenerationCoverage"
    WHERE ${covered} AND "modelVersionId" IN (${Prisma.join(modelVersionIds)})
  `;
  return new Set(rows.map((r) => r.modelVersionId));
}

function parseAvailability(availability: unknown): ResourceLoadAvailability {
  const parsed = resourceAvailabilitySchema.safeParse(availability);
  return parsed.success ? parsed.data : { status: 'unknown' };
}

/**
 * Live residency for a set of model versions.
 *
 * Uncached on purpose: `modelVersionResourceCache` holds the same `ResourceInfo` on a day-long TTL
 * and throws `availability` away, so it looks like it already has this and does not.
 */
export async function getResourceLoadState(
  modelVersionIds: number[],
  audience: { next: boolean; member: boolean }
): Promise<ResourceLoadState[]> {
  const versions = await getVersionsForAir(modelVersionIds);
  if (!versions.length) return [];

  const coveredIds = await getCoveredVersionIds(
    versions.map((v) => v.id),
    audience
  );

  const results: ResourceLoadState[] = [];
  const tasks = versions.map((version) => async () => {
    const air = modelVersionToAir(version);
    const base = {
      modelVersionId: version.id,
      modelId: version.model.id,
      air,
      name: version.name,
      modelName: version.model.name,
      eligible: isGenerationEligible({
        covered: coveredIds.has(version.id),
        baseModel: version.baseModel,
        modelType: version.model.type,
        flags: version.flags,
      }),
      ...checkLoadable(version.files, version.model.type),
    };

    if (generatorReadiness(version) === 'external') {
      results.push({ ...base, availability: { status: 'external' } });
      return;
    }

    const response = await getModelClient({ token: env.ORCHESTRATOR_ACCESS_TOKEN, air });
    if (!response?.data) {
      results.push({ ...base, availability: { status: 'unknown' } });
      return;
    }
    results.push({
      ...base,
      size: response.data.size,
      availability: parseAvailability(response.data.availability),
    });
  });

  await limitConcurrency(tasks, STATE_FETCH_CONCURRENCY);
  return results;
}

/**
 * The orchestrator's ranking is the render order — do not re-sort.
 *
 * The cursor is an offset over a list re-ranked from live state per request, so pages are not
 * stable: first-page-and-poll, not infinite scroll.
 */
export async function getResourceLoadQueue({ cursor, take }: GetResourceLoadQueueInput) {
  const { data, error } = await queryResourcesClient({
    token: env.ORCHESTRATOR_ACCESS_TOKEN,
    query: { view: 'queue', cursor, take },
  });
  if (!data) throw throwBadRequestError(error?.detail ?? 'Could not read the resource queue');

  // Rows whose AIR resolves to no version on this site are loaded outside our catalogue; drop them.
  const parsed = data.items.flatMap((item) => {
    const versionId = versionIdFromAir(item.air);
    return versionId ? [{ item, versionId }] : [];
  });

  const versions = await getVersionsForAir(parsed.map((x) => x.versionId));
  const versionsById = new Map(versions.map((v) => [v.id, v]));

  const items = parsed.flatMap(({ item, versionId }) => {
    const version = versionsById.get(versionId);
    if (!version) return [];
    return [
      {
        modelVersionId: version.id,
        modelId: version.model.id,
        air: item.air,
        name: version.name,
        modelName: version.model.name,
        size: item.size,
        availability: parseAvailability(item.availability),
      },
    ];
  });

  return { items, nextCursor: data.next ?? undefined };
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
  // Only what the AIR needs: `getPrimaryFile` scores on each file's type and metadata.
  const versions = (await dbRead.modelVersion.findMany({
    where: { id: { in: modelVersionIds } },
    select: {
      id: true,
      name: true,
      baseModel: true,
      flags: true,
      usageControl: true,
      model: { select: { id: true, name: true, type: true } },
      files: { select: { type: true, metadata: true } },
    },
  })) as VersionForAir[];

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

// Built on first use, not on import: ~150 suites wholesale-mock redis or cache-helpers, and an eager
// cache here fails every one of them at collection. See `no-module-scope-cache`.
let residencyCacheInstance: ReturnType<typeof createResourceResidencyCache> | undefined;
function resourceResidencyCache() {
  return (residencyCacheInstance ??= createResourceResidencyCache());
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

/** Refuses `available` too: the orchestrator accepts an already-resident prepare and completes it
 *  instantly, so the user would pay for nothing. */
async function resolveLoadable(modelVersionId: number) {
  // `member: true`: this is the PAID load path — the purchase IS what the gate asks for.
  const [state] = await getResourceLoadState([modelVersionId], {
    next: await nextCoverageEnabled(),
    member: true,
  });
  if (!state) throw throwNotFoundError(`No model version with id ${modelVersionId}`);

  if (!state.eligible)
    throw throwBadRequestError(
      'This resource cannot be generated with on the site, so loading it would buy nothing.'
    );
  if (!state.loadable)
    throw throwBadRequestError(UNLOADABLE_MESSAGES[state.unloadableReason ?? 'no-weights']);

  const { status } = state.availability;
  if (status === 'unsupported')
    throw throwBadRequestError('The generation cluster cannot host this resource.');
  if (status === 'unknown')
    throw throwBadRequestError('We could not read the status of this resource. Please try again.');
  if (status === 'available')
    throw throwBadRequestError('This resource is already loaded and ready to generate with.');

  return state;
}

function prepareResourceStep(air: string) {
  return { $type: 'prepareResource', name: PREPARE_STEP_NAME, input: { resource: air } };
}

/** 🔴 `CalculateCost` for a prepare step returns an empty cost, so `whatif` reports 0 until C2 —
 *  see docs/features/paid-model-loading.md. `priced` distinguishes that from a real quote. */
export async function estimateResourceLoad({
  modelVersionId,
  token,
  currencies,
}: {
  modelVersionId: number;
  token: string;
  currencies: BuzzSpendType[];
}) {
  const state = await resolveLoadable(modelVersionId);

  const workflow = await submitWorkflow({
    token,
    body: {
      steps: [prepareResourceStep(state.air)],
      // @ts-ignore - BuzzSpendType is properly supported
      currencies: BuzzTypes.toOrchestratorType(currencies),
    },
    query: { whatif: true },
  });

  const cost = workflow?.cost?.total ?? 0;
  return { ...state, cost, priced: cost > 0 };
}

/** Runs with the USER's token — the orchestrator derives whose queue this joins and whose Buzz pays
 *  from that bearer. */
export async function submitResourceLoad({
  modelVersionId,
  userId,
  token,
  currencies,
}: {
  modelVersionId: number;
  userId: number;
  token: string;
  currencies: BuzzSpendType[];
}) {
  const state = await resolveLoadable(modelVersionId);

  const workflow = await submitWorkflow({
    token,
    body: {
      steps: [prepareResourceStep(state.air)],
      callbacks: getResourceLoadCallbacks(userId),
      tags: ['resource-load'],
      // @ts-ignore - BuzzSpendType is properly supported
      currencies: BuzzTypes.toOrchestratorType(currencies),
    },
  });

  await assertWorkflowOwner(workflow, userId, token);

  return { ...state, workflowId: workflow?.id ?? null, status: workflow?.status ?? null };
}
