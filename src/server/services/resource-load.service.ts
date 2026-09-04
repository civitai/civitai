import type { ModelType } from '~/shared/utils/prisma/enums';
import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { getResourceLoadCallbacks } from '~/server/orchestrator/orchestrator.utils';
import type {
  GetResourceLoadQueueInput,
  ResourceLoadAvailability,
} from '~/server/schema/resource-load.schema';
import { resourceAvailabilitySchema } from '~/server/schema/resource-load.schema';
import { assertWorkflowOwner } from '~/server/services/orchestrator/assert-workflow-owner';
import { getModelClient, queryResourcesClient } from '~/server/services/orchestrator/models';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { modelVersionToAir } from '~/server/utils/resource-air';
import { parseAIRSafe } from '~/shared/utils/air';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { BuzzTypes } from '~/shared/constants/buzz.constants';

const PREPARE_STEP_NAME = 'prepare-resource';

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
};

type VersionForAir = {
  id: number;
  name: string;
  baseModel: string;
  model: { id: number; name: string; type: ModelType };
  files: { type: string; metadata: BasicFileMetadata }[];
};

async function getVersionsForAir(modelVersionIds: number[]) {
  return (await dbRead.modelVersion.findMany({
    where: { id: { in: modelVersionIds } },
    select: {
      id: true,
      name: true,
      baseModel: true,
      model: { select: { id: true, name: true, type: true } },
      files: { select: { type: true, metadata: true } },
    },
  })) as VersionForAir[];
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
  modelVersionIds: number[]
): Promise<ResourceLoadState[]> {
  const versions = await getVersionsForAir(modelVersionIds);
  if (!versions.length) return [];

  const results: ResourceLoadState[] = [];
  const tasks = versions.map((version) => async () => {
    const air = modelVersionToAir(version);
    const base = {
      modelVersionId: version.id,
      modelId: version.model.id,
      air,
      name: version.name,
      modelName: version.model.name,
    };

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
    const air = parseAIRSafe(item.air);
    return air?.version ? [{ item, versionId: air.version }] : [];
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

/** Refuses `available` too: the orchestrator accepts an already-resident prepare and completes it
 *  instantly, so the user would pay for nothing. */
async function resolveLoadable(modelVersionId: number) {
  const [state] = await getResourceLoadState([modelVersionId]);
  if (!state) throw throwNotFoundError(`No model version with id ${modelVersionId}`);

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
 *  see docs/features/paid-model-loading-checklist.md. `priced` distinguishes that from a real quote. */
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
      callbacks: getResourceLoadCallbacks(modelVersionId),
      tags: ['resource-load'],
      // @ts-ignore - BuzzSpendType is properly supported
      currencies: BuzzTypes.toOrchestratorType(currencies),
    },
  });

  await assertWorkflowOwner(workflow, userId, token);

  return { ...state, workflowId: workflow?.id ?? null, status: workflow?.status ?? null };
}
