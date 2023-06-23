import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CreateGenerationRequestInput,
  GetGenerationImagesInput,
  GetGenerationRequestsInput,
  GetGenerationResourcesInput,
} from '~/server/schema/generation.schema';
import { SessionUser } from 'next-auth';
import { dbRead } from '~/server/db/client';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { ModelType, Prisma } from '@prisma/client';
import { generationResourceSelect } from '~/server/selectors/generation.selector';
import {
  // GenerationRequestProps,
  // GenerationResourceModel,
  // ImageRequestProps,
  // JobProps,
  Generation,
  GenerationRequestStatus,
} from '~/server/services/generation/generation.types';
import { isDefined } from '~/utils/type-guards';
import { QS } from '~/utils/qs';
import { isDev } from '~/env/other';
import { env } from '~/env/server.mjs';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { redis } from '~/server/redis/client';

export function parseModelVersionId(assetId: string) {
  const pattern = /^@civitai\/(\d+)$/;
  const match = assetId.match(pattern);

  if (match) {
    return parseInt(match[1], 10);
  }

  return null;
}

function mapRequestStatus(label: string): GenerationRequestStatus {
  switch (label) {
    case 'Pending':
      return GenerationRequestStatus.Pending;
    case 'Processing':
      return GenerationRequestStatus.Processing;
    case 'Cancelled':
      return GenerationRequestStatus.Cancelled;
    case 'Error':
      return GenerationRequestStatus.Error;
    case 'Succeeded':
      return GenerationRequestStatus.Succeeded;
    default:
      throw new Error(`Invalid status label: ${label}`);
  }
}

export const getGenerationResource = async ({
  id,
}: GetByIdInput): Promise<Generation.Client.Resource> => {
  const resource = await dbRead.modelVersion.findUnique({
    where: { id },
    select: generationResourceSelect,
  });
  if (!resource) throw throwNotFoundError();
  const { model, ...x } = resource;
  return {
    id: x.id,
    name: x.name,
    trainedWords: x.trainedWords,
    modelId: model.id,
    modelName: model.name,
    modelType: model.type,
  };
};

export const getGenerationResources = async ({
  take,
  query,
  types,
  notTypes,
  ids, // used for getting initial values of resources
  user,
}: GetGenerationResourcesInput & { user?: SessionUser }): Promise<Generation.Client.Resource[]> => {
  // TODO - apply user preferences - but do we really need this? Maybe a direct search should yield all results since their browsing experience is already set to their browsing preferences
  // TODO.Justin - optimize sql query for selecting resources
  const AND: Prisma.Enumerable<Prisma.ModelVersionWhereInput> = [{ publishedAt: { not: null } }];
  const MODEL_AND: Prisma.Enumerable<Prisma.ModelWhereInput> = [];
  if (ids) AND.push({ id: { in: ids } });
  if (!!types?.length) MODEL_AND.push({ type: { in: types } });
  if (!!notTypes?.length) MODEL_AND.push({ type: { notIn: notTypes } });
  if (query) {
    // MODEL_AND.push({ name: { contains: query, mode: 'insensitive' } });
    AND.push({
      OR: [
        { files: { some: { name: { startsWith: query, mode: 'insensitive' } } } },
        { files: { some: { hashes: { some: { hash: query } } } } },
        { trainedWords: { has: query } }, // TODO - filter needs to be able to do something like 'startsWith' or 'contains'
        { model: { name: { contains: query, mode: 'insensitive' } } },
      ],
    });
  }
  if (!!MODEL_AND.length) AND.push({ model: { AND: MODEL_AND } });

  const coveredModelVersions = await getGenerationCoverage();
  if (coveredModelVersions) {
    AND.push({ id: { in: coveredModelVersions } });
  }

  const results = await dbRead.modelVersion.findMany({
    take,
    where: { AND },
    select: generationResourceSelect,
    orderBy: { id: 'desc' },
  });

  return results
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map(({ model, ...x }) => ({
      id: x.id,
      name: x.name,
      trainedWords: x.trainedWords,
      modelId: model.id,
      modelName: model.name,
      modelType: model.type,
    }));
};

export const getGenerationRequests = async (
  props: GetGenerationRequestsInput & { userId: number }
) => {
  const params = QS.stringify(props);
  const response = await fetch(`${env.SCHEDULER_ENDPOINT}/requests?${params}`);
  if (!response.ok) throw new Error(response.statusText);
  const { cursor, requests }: Generation.Api.Request = await response.json();
  const modelVersionIds = requests
    .map((x) => parseModelVersionId(x.job.model))
    .concat(requests.flatMap((x) => Object.keys(x.job.additionalNetworks).map(parseModelVersionId)))
    .filter((x) => x !== null) as number[];

  const modelVersions = await dbRead.modelVersion.findMany({
    where: { id: { in: modelVersionIds } },
    select: generationResourceSelect,
  });

  // // TODO.generation - nextCursor should be returned from the image generation api, so this will need to be modified when that occurs
  // let nextCursor: number | undefined;
  // if (requests.length > props.take) {
  //   const nextItem = requests.pop();
  //   nextCursor = nextItem?.id;
  // }

  const items = requests.map((x): Generation.Client.Request => {
    const { additionalNetworks, ...job } = x.job;

    const assets = [x.job.model, ...Object.keys(x.job.additionalNetworks)];

    return {
      id: x.id,
      createdAt: x.createdAt,
      estimatedCompletionDate: x.estimatedCompletedAt,
      status: mapRequestStatus(x.status),
      resources: assets
        .map((assetId): Generation.Client.Resource | undefined => {
          const modelVersionId = parseModelVersionId(assetId);
          const modelVersion = modelVersions.find((x) => x.id === modelVersionId);
          const network = x.job.additionalNetworks[assetId] ?? {};
          if (!modelVersion) return undefined;
          const { model } = modelVersion;
          return {
            id: modelVersion.id,
            name: modelVersion.name,
            trainedWords: modelVersion.trainedWords,
            modelId: model.id,
            modelName: model.name,
            modelType: model.type,
            ...network,
          };
        })
        .filter(isDefined),
      ...job,
      images: x.images,
    };
  });

  return { items, nextCursor: cursor === 0 ? undefined : cursor ?? undefined };
};

const additionalNetworkTypes = [ModelType.LORA, ModelType.LoCon, ModelType.Hypernetwork];
type ModelFileResult = {
  url: string;
  name: string;
  type: ModelType;
  metadata: FileMetadata;
  modelVersionId: number;
  hash?: string;
};
type GenerationRequestAdditionalNetwork = {
  strength?: number;
};
export const createGenerationRequest = async ({
  userId,
  ...props
}: CreateGenerationRequestInput & { userId: number }) => {
  const checkpoint = props.resources.find((x) => x.type === ModelType.Checkpoint);
  if (!checkpoint)
    throw throwBadRequestError('A checkpoint is required to make a generation request');
  // TODO Koen: Finish connecting this to the scheduler.
  // For textual inversions, pull in the trigger words of the model version (there should only be one).

  const response = await fetch(`${env.SCHEDULER_ENDPOINT}/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId,
      job: {
        model: `@civitai/${checkpoint.modelVersionId}`,
        quantity: props.quantity,
        additionalNetworks: props.resources
          .filter((x) => x !== checkpoint)
          .reduce((acc, obj) => {
            const { modelVersionId, ...rest } = obj;
            acc[modelVersionId] = rest;
            return acc;
          }, {} as { [key: string]: object }),
        params: {
          prompt: props.prompt,
          negativePrompt: props.negativePrompt,
          scheduler: 'EulerA', // props.sampler, // todo: synchronize terminology, use from user input
          steps: props.steps,
          cfgScale: props.cfgScale,
          width: props.width,
          height: props.height,
          seed: props.seed,
        },
      },
    }),
  });

  // todo: whats next
};

export const getGenerationImages = async (props: GetGenerationImagesInput & { userId: number }) => {
  const params = QS.stringify(props);
  const response = await fetch(`${env.SCHEDULER_ENDPOINT}/images?${params}`);
  if (!response.ok) throw new Error(response.statusText);
  const { cursor, images, requests }: Generation.Api.Images = await response.json();

  // // TODO.generation - nextCursor should be returned from the image generation api, so this will need to be modified when that occurs
  // let nextCursor: number | undefined;
  // if (images.length > props.take) {
  //   const nextItem = images.pop();
  //   nextCursor = nextItem?.id;
  // }

  return {
    nextCursor: cursor ?? undefined,
    images,
    requests: requests.reduce<Generation.Client.ImageRequestDictionary>((acc, request) => {
      if (!images.find((x) => x.requestId === request.id)) return acc;
      return {
        ...acc,
        [request.id]: {
          params: request.job.params,
        },
      };
    }, {}),
  };
};

const generationCoverageCacheKey = 'IMAGEN_AVAILABLE_MODELVERSIONS';

export async function refreshGeneratioCoverage() {
  const response = await fetch(`${env.SCHEDULER_ENDPOINT}/coverage`);
  const coverage = (await response.json()) as Generation.Client.Coverage;

  const availableModelVersions = Object.keys(coverage.assets)
    .filter((assetKey) => coverage.assets[assetKey].workers > 0)
    .map((x) => parseModelVersionId(x))
    .filter((x) => x) as number[];

  await redis.set(generationCoverageCacheKey, JSON.stringify(availableModelVersions));
  return availableModelVersions;
}

export async function getGenerationCoverage() {
  const coverage = await redis.get(generationCoverageCacheKey);
  if (!coverage) {
    return refreshGeneratioCoverage();
  }

  return JSON.parse(coverage) as number[];
}
