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

const imageGenerationApi = 'https://image-generation-scheduler.civitai.com';

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
  // TODO.Justin - sql query for selecting resources
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

export const getGenerationRequests = async ({
  cursor,
  ...props
}: GetGenerationRequestsInput & { userId: number }) => {
  if (isDev) props.userId = 1; // TODO.remove after generation is working properly
  const params = QS.stringify({ ...props, after: cursor, take: props.take + 1 });
  const response = await fetch(`${imageGenerationApi}/requests?${params}`);
  if (!response.ok) throw new Error(response.statusText);
  const requests: Generation.Api.Request[] = await response.json();
  const modelVersionIds = requests.flatMap((x) => x.assets.map((x) => x.modelVersionId));
  const modelVersions = await dbRead.modelVersion.findMany({
    where: { id: { in: modelVersionIds } },
    select: generationResourceSelect,
  });

  // TODO.generation - nextCursor should be returned from the image generation api, so this will need to be modified when that occurs
  let nextCursor: number | undefined;
  if (requests.length > props.take) {
    const nextItem = requests.pop();
    nextCursor = nextItem?.id;
  }

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

  return { items, nextCursor };
};

export const createGenerationRequest = async (
  props: CreateGenerationRequestInput & { userId: number }
) => {
  const checkpoint = props.resources.find((x) => x.type === ModelType.Checkpoint);
  if (!checkpoint)
    throw throwBadRequestError('A checkpoint is required to make a generation request');
  //TODO.Justin - get model files/hashes and any associated config files
};

export const getGenerationImages = async ({
  cursor,
  ...props
}: GetGenerationImagesInput & { userId: number }) => {
  if (isDev) props.userId = 1; // TODO.remove after generation is working properly
  const params = QS.stringify({ ...props, after: cursor, take: props.take + 1 });
  const response = await fetch(`${imageGenerationApi}/images?${params}`);
  if (!response.ok) throw new Error(response.statusText);
  const { images, requests }: Generation.Api.Images = await response.json();

  // TODO.generation - nextCursor should be returned from the image generation api, so this will need to be modified when that occurs
  let nextCursor: number | undefined;
  if (images.length > props.take) {
    const nextItem = images.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
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
