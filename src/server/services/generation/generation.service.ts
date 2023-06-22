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
} from '~/server/services/generation/generation.types';
import { isDefined } from '~/utils/type-guards';
import { QS } from '~/utils/qs';
import { isDev } from '~/env/other';
import { env } from '~/env/server.mjs';
import { getPrimaryFile } from '~/server/utils/model-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';

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
  const modelVersionIds = requests.flatMap((x) => x.assets.map((x) => x.modelVersionId));
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
    return {
      id: x.id,
      createdAt: x.createdAt,
      estimatedCompletionDate: x.estimatedCompletionDate,
      status: x.status,
      resources: x.assets
        .map((asset): Generation.Client.Resource | undefined => {
          const modelVersion = modelVersions.find((x) => x.id === asset.modelVersionId);
          const network = additionalNetworks[asset.hash] ?? {};
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
type GenerationRequestAsset = {
  type: ModelType;
  hash?: string;
  url: string;
  modelVersionId: number;
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

  const versionIds = props.resources.map((x) => x.modelVersionId);
  const files = await dbRead.$queryRaw<ModelFileResult[]>`
    SELECT
      mf.url,
      mf.name,
      mf.type,
      mf.metadata,
      mf."modelVersionId",
      (SELECT mfh.hash FROM "ModelFileHash" mfh WHERE mfh."modelFileId" = mf.id AND mfh.type = 'SHA256') as "hash"
    FROM "ModelFile" mf
    WHERE mf."modelVersionId" IN (${Prisma.join(versionIds)});
  `;

  // For textual inversions, pull in the trigger words of the model version (there should only be one).

  const assets: GenerationRequestAsset[] = [];
  const additionalNetworks: Record<string, GenerationRequestAdditionalNetwork> = {};
  for (const resource of props.resources) {
    const versionFiles = files.filter((x) => x.modelVersionId === resource.modelVersionId);
    const primaryFile = getPrimaryFile(versionFiles);
    if (!primaryFile) throw throwBadRequestError('No primary file found for model version');

    // Prepare asset
    const downloadUrl = `${getBaseUrl()}/api/download/models/${primaryFile.modelVersionId}?fp=${
      primaryFile.metadata.fp
    }&size=${primaryFile.metadata.size}&format=${primaryFile.metadata.format}&type=${
      primaryFile.type
    }`;
    assets.push({
      type: resource.type,
      hash: primaryFile.hash,
      url: downloadUrl,
      modelVersionId: resource.modelVersionId,
    });

    // Prepare additional networks
    if (additionalNetworkTypes.includes(resource.type)) {
      additionalNetworks[`@civitai/${resource.modelVersionId}`] = {
        strength: resource.strength,
        type: resource.type,
        // trigger word for textual inversion
      };
    }
  }

  const response = await fetch(`${env.SCHEDULER_ENDPOINT}/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId,
      assets,
      job: {
        quantity: props.quantity,
        additionalNetworks,
      },
    }),
  });
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
