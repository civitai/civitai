import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CreateGenerationRequestInput,
  GetGenerationImagesInput,
  GetGenerationRequestsInput,
  GetGenerationResourcesInput,
} from '~/server/schema/generation.schema';
import { SessionUser } from 'next-auth';
import { dbRead, dbWrite } from '~/server/db/client';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { GenerationSchedulers, ModelType, Prisma } from '@prisma/client';
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
import { Sampler } from '~/server/common/constants';

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
  const AND: Prisma.Enumerable<Prisma.ModelVersionWhereInput> = [
    { publishedAt: { not: null } },
    {
      modelVersionGenerationCoverage: {
        workers: {
          gt: 0,
        },
      },
    },
  ];
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

  const results = await dbRead.modelVersion.findMany({
    take,
    where: { AND },
    select: generationResourceSelect,
    orderBy: { id: 'desc' },
  });

  // It would be preferrable to do a join when fetching the modelVersions
  // Not sure if this is possible wth prisma queries are there is no defined relationship
  const allServiceProviders = await dbRead.generationServiceProvider.findMany({
    select: {
      name: true,
      schedulers: true,
    },
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
      serviceProviders: allServiceProviders.filter(
        (sp) => (x.modelVersionGenerationCoverage?.serviceProviders ?? []).indexOf(sp.name) !== -1
      ),
    }));
};

const formatGenerationRequests = async (requests: Generation.Api.RequestProps[]) => {
  const modelVersionIds = requests
    .map((x) => parseModelVersionId(x.job.model))
    .concat(requests.flatMap((x) => Object.keys(x.job.additionalNetworks).map(parseModelVersionId)))
    .filter((x) => x !== null) as number[];

  const modelVersions = await dbRead.modelVersion.findMany({
    where: { id: { in: modelVersionIds } },
    select: generationResourceSelect,
  });

  return requests.map((x): Generation.Client.Request => {
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
};

export const getGenerationRequests = async (
  props: GetGenerationRequestsInput & { userId: number }
) => {
  const params = QS.stringify(props);
  const response = await fetch(`${env.SCHEDULER_ENDPOINT}/requests?${params}`);
  if (!response.ok) throw new Error(response.statusText);
  const { cursor, requests }: Generation.Api.Request = await response.json();
  // // TODO.generation - nextCursor should be returned from the image generation api, so this will need to be modified when that occurs
  // let nextCursor: number | undefined;
  // if (requests.length > props.take) {
  //   const nextItem = requests.pop();
  //   nextCursor = nextItem?.id;
  // }

  const items = await formatGenerationRequests(requests);

  return { items, nextCursor: cursor === 0 ? undefined : cursor ?? undefined };
};

const samplersToSchedulers: Record<Sampler, string> = {
  'Euler a': 'EulerA',
  Euler: 'Euler',
  LMS: 'LMS',
  Heun: 'Heun',
  DPM2: 'DPM2',
  'DPM2 a': 'DPM2A',
  'DPM++ 2S a': 'DPM2SA',
  'DPM++ 2M': 'DPM2M',
  'DPM++ SDE': 'DPMSDE',
  'DPM fast': 'DPMFast',
  'DPM adaptive': 'DPMAdaptive',
  'LMS Karras': 'LMSKarras',
  'DPM2 Karras': 'DPM2Karras',
  'DPM2 a Karras': 'DPM2AKarras',
  'DPM++ 2S a Karras': 'DPM2SAKarras',
  'DPM++ 2M Karras': 'DPM2MKarras',
  'DPM++ SDE Karras': 'DPMSDEKarras',
  DDIM: 'DDIM',
  PLMS: 'PLMS',
  UniPC: 'UniPC',
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

  // TODO: Justin For textual inversions, pull in the trigger words of the model version (there should only be one).

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
            acc[`@civitai/${modelVersionId}`] = rest;
            return acc;
          }, {} as { [key: string]: object }),
        params: {
          prompt: props.prompt,
          negativePrompt: props.negativePrompt,
          scheduler: samplersToSchedulers[props.sampler],
          steps: props.steps,
          cfgScale: props.cfgScale,
          width: props.width,
          height: props.height,
          seed: props.seed ?? -1,
        },
      },
    }),
  });

  if (!response.ok) {
    const message = await response.json();
    throw throwBadRequestError(message);
  }
  const data: Generation.Api.RequestProps = await response.json();
  const [formatted] = await formatGenerationRequests([data]);
  return formatted;
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

export async function refreshGenerationCoverage() {
  const response = await fetch(`${env.SCHEDULER_ENDPOINT}/coverage`);
  const coverage = (await response.json()) as Generation.Client.Coverage;

  const modelVersionCoverage = Object.keys(coverage.assets)
    .map((x) => ({
      modelVersionId: parseModelVersionId(x) as number,
      workers: coverage.assets[x].workers,
      serviceProviders: Object.keys(coverage.assets[x].serviceProviders),
    }))
    .filter((x) => x.modelVersionId !== null);

  const values = modelVersionCoverage
    .map(
      (data) =>
        `(${data.modelVersionId}, ${data.workers}, ARRAY[${data.serviceProviders
          .map((x) => `'${x}'`)
          .join(',')}])`
    )
    .join(', ');

  await dbWrite.$queryRawUnsafe(`
    INSERT INTO "ModelVersionGenerationCoverage" ("modelVersionId", "workers", "serviceProviders")
    SELECT mv."id", mc."workers", mc."serviceProviders"
    FROM (VALUES ${values}) AS mc ("modelVersionId", "workers", "serviceProviders")
    JOIN "ModelVersion" mv ON mv."id" = mc."modelVersionId"
    ON CONFLICT ("modelVersionId")
    DO UPDATE
    SET "workers" = EXCLUDED."workers",
        "serviceProviders" = EXCLUDED."serviceProviders";
  `);

  // const serviceProviders = [];
  // for (const schedulerEntry of Object.entries(coverage.schedulers)) {
  //   const scheduler = schedulerEntry[0];
  //   const mappedScheduler: GenerationSchedulers = scheduler;
  //   const schedulerCoverage = schedulerEntry[1];
  //   for (const serviceProvider of schedulerCoverage.serviceProviders) {
  //   }
  // }
}
