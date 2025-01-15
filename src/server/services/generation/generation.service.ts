import { Prisma } from '@prisma/client';
import { uniqBy } from 'lodash-es';
import { SessionUser } from 'next-auth';
import { getGenerationConfig } from '~/server/common/constants';

import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { resourceDataCache } from '~/server/redis/caches';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  CheckResourcesCoverageSchema,
  GenerationStatus,
  generationStatusSchema,
  GetGenerationDataInput,
  GetGenerationResourcesInput,
} from '~/server/schema/generation.schema';

import { imageGenerationSchema } from '~/server/schema/image.schema';
import { TextToImageParams } from '~/server/schema/orchestrator/textToImage.schema';
import { modelsSearchIndex } from '~/server/search-index';
import { getImageGenerationResources } from '~/server/services/image.service';
import {
  handleLogError,
  throwAuthorizationError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';

import { getPagedData } from '~/server/utils/pagination-helpers';
import {
  formatGenerationResources,
  GenerationResource,
  getBaseModelFromResources,
  getBaseModelSet,
} from '~/shared/constants/generation.constants';
import { MediaType } from '~/shared/utils/prisma/enums';

import { fromJson, toJson } from '~/utils/json-helpers';
import { cleanPrompt } from '~/utils/metadata/audit';
import { findClosest } from '~/utils/number-helpers';

export function parseModelVersionId(assetId: string) {
  const pattern = /^@civitai\/(\d+)$/;
  const match = assetId.match(pattern);

  if (match) {
    return parseInt(match[1], 10);
  }

  return null;
}

// const baseModelSetsArray = Object.values(baseModelSets);
/** @deprecated using search index instead... */
export const getGenerationResources = async (
  input: GetGenerationResourcesInput & { user?: SessionUser }
) => {
  return await getPagedData<GetGenerationResourcesInput, GenerationResource[]>(
    input,
    async ({
      take,
      skip,
      query,
      types,
      notTypes,
      ids, // used for getting initial values of resources
      baseModel,
      supported,
    }) => {
      const preselectedVersions: number[] = [];
      if ((!ids || ids.length === 0) && !query) {
        const featuredCollection = await dbRead.collection
          .findFirst({
            where: { userId: -1, name: 'Generator' },
            select: {
              items: {
                select: {
                  model: {
                    select: {
                      name: true,
                      type: true,
                      modelVersions: {
                        select: { id: true, name: true },
                        where: { status: 'Published' },
                        orderBy: { index: 'asc' },
                        take: 1,
                      },
                    },
                  },
                },
              },
            },
          })
          .catch(() => null);

        if (featuredCollection)
          preselectedVersions.push(
            ...featuredCollection.items.flatMap(
              (x) => x.model?.modelVersions.map((x) => x.id) ?? []
            )
          );

        ids = preselectedVersions;
      }

      const sqlAnd = [Prisma.sql`mv.status = 'Published' AND m.status = 'Published'`];
      if (ids && ids.length > 0) sqlAnd.push(Prisma.sql`mv.id IN (${Prisma.join(ids, ',')})`);
      if (!!types?.length)
        sqlAnd.push(Prisma.sql`m.type = ANY(ARRAY[${Prisma.join(types, ',')}]::"ModelType"[])`);
      if (!!notTypes?.length)
        sqlAnd.push(Prisma.sql`m.type != ANY(ARRAY[${Prisma.join(notTypes, ',')}]::"ModelType"[])`);
      if (query) {
        const pgQuery = '%' + query + '%';
        sqlAnd.push(Prisma.sql`m.name ILIKE ${pgQuery}`);
      }
      if (baseModel) {
        // const baseModelSet = baseModelSetsArray.find((x) => x.includes(baseModel as BaseModel));
        const baseModelSet = getBaseModelSet(baseModel);
        if (baseModelSet.length)
          sqlAnd.push(Prisma.sql`mv."baseModel" IN (${Prisma.join(baseModelSet, ',')})`);
      }

      let orderBy = 'mv.index';
      if (!query) orderBy = `mm."thumbsUpCount", ${orderBy}`;

      const results = await dbRead.$queryRaw<Array<GenerationResource & { index: number }>>`
        SELECT
          mv.id,
          mv.index,
          mv.name,
          mv."trainedWords",
          m.id "modelId",
          m.name "modelName",
          m.type "modelType",
          mv."baseModel",
          mv.settings->>'strength' strength,
          mv.settings->>'minStrength' "minStrength",
          mv.settings->>'maxStrength' "maxStrength"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        ${Prisma.raw(
          supported
            ? `JOIN "GenerationCoverage" gc ON gc."modelVersionId" = mv.id AND gc.covered = true`
            : ''
        )}
        ${Prisma.raw(
          orderBy.startsWith('mm')
            ? `JOIN "ModelMetric" mm ON mm."modelId" = m.id AND mm.timeframe = 'AllTime'`
            : ''
        )}
        WHERE ${Prisma.join(sqlAnd, ' AND ')}
        ORDER BY ${Prisma.raw(orderBy)}
        LIMIT ${take}
        OFFSET ${skip}
      `;
      const rowCount = await dbRead.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*)
        FROM "ModelVersion" mv
        JOIN "Model" m ON m.id = mv."modelId"
        ${Prisma.raw(
          supported
            ? `JOIN "GenerationCoverage" gc ON gc."modelVersionId" = mv.id AND gc.covered = true`
            : ''
        )}
        WHERE ${Prisma.join(sqlAnd, ' AND ')}
      `;
      const [{ count }] = rowCount;

      return {
        items: results.map((resource) => ({
          ...resource,
          strength: 1,
        })),
        count,
      };
    }
  );
};

export async function checkResourcesCoverage({ id }: CheckResourcesCoverageSchema) {
  const unavailableGenResources = await getUnavailableResources();
  const result = await dbRead.generationCoverage.findFirst({
    where: { modelVersionId: id },
    select: { covered: true },
  });

  return (result?.covered ?? false) && unavailableGenResources.indexOf(id) === -1;
}

export async function getGenerationStatus() {
  const status = generationStatusSchema.parse(
    JSON.parse(
      (await sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, REDIS_SYS_KEYS.GENERATION.STATUS)) ??
        '{}'
    )
  );

  return status as GenerationStatus;
}

export type RemixOfProps = {
  id?: number;
  url?: string;
  type: MediaType;
  similarity?: number;
};
export type GenerationData = {
  remixOfId?: number;
  resources: GenerationResource[];
  params: Partial<TextToImageParams>;
  remixOf?: RemixOfProps;
};

export const getGenerationData = async (props: GetGenerationDataInput): Promise<GenerationData> => {
  switch (props.type) {
    case 'image':
    case 'video':
      return await getMediaGenerationData(props.id);
    case 'modelVersion':
      return await getResourceGenerationData({ modelVersionId: props.id });
    case 'modelVersions':
      return await getMultipleResourceGenerationData({ versionIds: props.ids });
    default:
      throw new Error('unsupported generation data type');
  }
};

async function getMediaGenerationData(id: number): Promise<GenerationData> {
  const media = await dbRead.image.findUnique({
    where: { id },
    select: {
      id: true,
      type: true,
      url: true,
      meta: true,
      height: true,
      width: true,
    },
  });
  if (!media) throw throwNotFoundError();

  const width = media.width ? media.width : 0;
  const height = media.height ? media.height : 0;
  const remixOf: RemixOfProps = {
    id: media.id,
    type: media.type,
    url: media.url,
    similarity: 1,
  };

  const { prompt, negativePrompt } = cleanPrompt(media.meta as Record<string, any>);
  const common = {
    prompt,
    negativePrompt,
  };

  switch (media.type) {
    case 'image':
      const resources = await getImageGenerationResources(media.id);
      const baseModel = getBaseModelFromResources(resources);

      let aspectRatio = '0';
      try {
        if (width && height) {
          const config = getGenerationConfig(baseModel);
          const ratios = config.aspectRatios.map((x) => x.width / x.height);
          const closest = findClosest(ratios, width / height);
          aspectRatio = `${ratios.indexOf(closest)}`;
        }
      } catch (e) {}

      const {
        'Clip skip': legacyClipSkip,
        clipSkip = legacyClipSkip,
        comfy, // don't return to client
        external, // don't return to client
        ...meta
      } = imageGenerationSchema.parse(media.meta);

      if (meta.hashes && meta.prompt) {
        for (const [key, hash] of Object.entries(meta.hashes)) {
          if (!['lora:', 'lyco:'].some((x) => key.startsWith(x))) continue;

          // get the resource that matches the hash
          const uHash = hash.toUpperCase();
          const resource = resources.find((x) => x.hash === uHash);
          if (!resource || resource.strength) continue;

          // get everything that matches <key:{number}>
          const matches = new RegExp(`<${key}:([0-9\.]+)>`, 'i').exec(meta.prompt);
          if (!matches) continue;

          resource.strength = parseFloat(matches[1]);
        }
      }

      return {
        remixOfId: media.id, // TODO - remove
        remixOf,
        resources,
        params: {
          ...common,
          cfgScale: meta.cfgScale !== 0 ? meta.cfgScale : undefined,
          steps: meta.steps !== 0 ? meta.steps : undefined,
          seed: meta.seed !== 0 ? meta.seed : undefined,
          width,
          height,
          aspectRatio,
          baseModel,
          clipSkip,
        },
      };
    case 'video':
      return {
        remixOfId: media.id, // TODO - remove,
        remixOf,
        resources: [] as GenerationResource[],
        params: {
          ...(media.meta as Record<string, any>),
          ...common,
          width,
          height,
        },
      };
    case 'audio':
      throw new Error('not implemented');
  }
}

export const getResourceGenerationData = async ({ modelVersionId }: { modelVersionId: number }) => {
  if (!modelVersionId) throw new Error('modelVersionId required');
  const resources = await resourceDataCache.fetch([modelVersionId]);
  if (!resources.length) throw throwNotFoundError();

  const [resource] = resources;
  if (resource.vaeId) {
    const [vae] = await resourceDataCache.fetch([resource.vaeId]);
    if (vae) resources.push({ ...vae, vaeId: null });
  }

  const deduped = uniqBy(formatGenerationResources(resources), 'id');

  return {
    resources: deduped,
    params: {
      baseModel: getBaseModelFromResources(deduped),
      clipSkip: resource.clipSkip ?? undefined,
    },
  };
};

const getMultipleResourceGenerationData = async ({ versionIds }: { versionIds: number[] }) => {
  if (!versionIds.length) throw new Error('missing version ids');
  const resources = await resourceDataCache.fetch(versionIds);
  const checkpoint = resources.find((x) => x.baseModel === 'Checkpoint');
  if (checkpoint?.vaeId) {
    const [vae] = await resourceDataCache.fetch([checkpoint.vaeId]);
    if (vae) resources.push({ ...vae, vaeId: null });
  }

  const deduped = uniqBy(formatGenerationResources(resources), 'id');

  return {
    resources: deduped,
    params: {
      baseModel: getBaseModelFromResources(deduped),
    },
  };
};

export async function getUnstableResources() {
  const cachedData = await sysRedis
    .hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, 'generation:unstable-resources')
    .then((data) => (data ? fromJson<number[]>(data) : ([] as number[])))
    .catch(() => [] as number[]); // fallback to empty array if redis fails

  return cachedData ?? [];
}

export async function getUnavailableResources() {
  const cachedData = await sysRedis
    .hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, 'generation:unavailable-resources')
    .then((data) => (data ? fromJson<number[]>(data) : ([] as number[])))
    .catch(() => [] as number[]); // fallback to empty array if redis fails

  return [...new Set(cachedData ?? [])];
}

export async function toggleUnavailableResource({
  id,
  isModerator,
}: GetByIdInput & { isModerator?: boolean }) {
  if (!isModerator) throw throwAuthorizationError();

  const unavailableResources = await getUnavailableResources();
  const index = unavailableResources.indexOf(id);
  if (index > -1) unavailableResources.splice(index, 1);
  else unavailableResources.push(id);

  await sysRedis.hSet(
    REDIS_SYS_KEYS.SYSTEM.FEATURES,
    'generation:unavailable-resources',
    toJson(unavailableResources)
  );

  const modelVersion = await dbRead.modelVersion.findUnique({
    where: { id },
    select: { modelId: true },
  });
  if (modelVersion)
    modelsSearchIndex
      .queueUpdate([
        {
          id: modelVersion.modelId,
          action: SearchIndexUpdateQueueAction.Update,
        },
      ])
      .catch(handleLogError);

  return unavailableResources;
}
