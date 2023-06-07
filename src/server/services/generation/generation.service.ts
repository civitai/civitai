import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CreateGenerationRequestInput,
  GetGenerationRequestsInput,
  GetGenerationResourcesInput,
} from '~/server/schema/generation.schema';
import { SessionUser } from 'next-auth';
import { dbRead } from '~/server/db/client';
import { throwBadRequestError, throwNotFoundError } from '~/server/utils/errorHandling';
import { ModelType, Prisma } from '@prisma/client';
import { generationResourceSelect } from '~/server/selectors/generation.selector';
import {
  GenerationRequestProps,
  GenerationResourceModel,
} from '~/server/services/generation/generation.types';
import { isDefined } from '~/utils/type-guards';
import { QS } from '~/utils/qs';

const imageGenerationApi = 'https://image-generation-scheduler.civitai.com';

export const getGenerationResource = async ({
  id,
}: GetByIdInput): Promise<GenerationResourceModel> => {
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
  type,
  ids, // used for getting initial values of resources
  user,
}: GetGenerationResourcesInput & { user?: SessionUser }): Promise<GenerationResourceModel[]> => {
  // TODO - apply user preferences - but do we really need this? Maybe a direct search should yield all results since their browsing experience is already set to their browsing preferences
  // TODO.Justin - sql query for selecting resources
  const AND: Prisma.Enumerable<Prisma.ModelVersionWhereInput> = [{ publishedAt: { not: null } }];
  const MODEL_AND: Prisma.Enumerable<Prisma.ModelWhereInput> = [];
  if (ids) AND.push({ id: { in: ids } });
  if (type) MODEL_AND.push({ type });
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

export type GenerationRequestModel = AsyncReturnType<typeof getGenerationRequests>[number];
export const getGenerationRequests = async (
  props: GetGenerationRequestsInput & { userId: number }
) => {
  const params = QS.stringify(props);
  const response = await fetch(`${imageGenerationApi}/requests?${params}`);
  if (!response.ok) throw new Error(response.statusText);
  const requests: GenerationRequestProps[] = await response.json();
  const modelVersionIds = requests.flatMap((x) => x.assets.map((x) => x.modelVersionId));
  const modelVersions = await dbRead.modelVersion.findMany({
    where: { id: { in: modelVersionIds } },
    select: generationResourceSelect,
  });

  return requests.map((x) => {
    const { additionalNetworks, ...job } = x.job;
    return {
      requestId: x.id,
      createdAt: x.createdAt,
      status: x.status,
      resources: x.assets
        .map((asset): GenerationResourceModel | undefined => {
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
    };
  });
};

export const createGenerationRequest = async (
  props: CreateGenerationRequestInput & { userId: number }
) => {
  const checkpoint = props.resources.find((x) => x.type === ModelType.Checkpoint);
  if (!checkpoint)
    throw throwBadRequestError('A checkpoint is required to make a generation request');
  //TODO.Justin - get model files/hashes and any associated config files
};
