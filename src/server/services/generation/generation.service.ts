import { Prisma } from '@prisma/client';
import { uniqBy } from 'lodash-es';
import { z } from 'zod';
import type { SessionUser } from '~/types/session';
import { EntityAccessPermission, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { getDbWithoutLag, getDbWithoutLagBatch } from '~/server/db/db-lag-helpers';
import { wanBaseModelGroupIdMap } from '~/server/services/orchestrator/ecosystems/wan.handler';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import type { GetByIdInput } from '~/server/schema/base.schema';
import type {
  CheckResourcesCoverageSchema,
  GenerationStatus,
  GenerationStatusMode,
  GetGenerationDataSchema,
  GetGenerationResourcesInput,
  ResolveImageMetaInput,
} from '~/server/schema/generation.schema';
import { generationStatusSchema } from '~/server/schema/generation.schema';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { modelsSearchIndex } from '~/server/search-index';
import { hasEntityAccess } from '~/server/services/common.service';
import type { ModelFileCached } from '~/server/services/model-file.service';
import { getFilesForModelVersionCache } from '~/server/services/model-file.service';
import type { GenerationResourceDataModel } from '~/server/redis/resource-data.redis';
import { resourceDataCache } from '~/server/redis/resource-data.redis';
import { getFeaturedModels } from '~/server/services/model.service';
import { getLinkedVaeIds } from '~/server/services/model-version.service';
import type { GenerationAlias, ModelVersionMeta } from '~/server/schema/model-version.schema';
import { imagesForModelVersionsCache } from '~/server/services/image.service';
import {
  handleLogError,
  throwAuthorizationError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getPrimaryFile, getTrainingFileEpochNumberDetails } from '~/server/utils/model-helpers';
import { getPagedData } from '~/server/utils/pagination-helpers';
import {
  fluxKreaAir,
  fluxUltraAir,
  getBaseModelFromResources,
  ponyV7Air,
} from '~/shared/constants/generation.constants';
import type { MediaType, ModelType } from '~/shared/utils/prisma/enums';
import type { GenerationResource } from '~/shared/types/generation.types';

import {
  applicableRulesFor,
  gateRuleSchema,
  rulesToStates,
  type GateRule,
} from '~/shared/data-graph/generation/gates';
import { fromJson, toJson } from '~/utils/json-helpers';
import { removeNulls } from '~/utils/object-helpers';
import { parseAIR, stringifyAIR } from '~/shared/utils/air';
import { Flags } from '~/shared/utils/flags';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { isDefined } from '~/utils/type-guards';
import type { BaseModelGroup } from '~/shared/constants/basemodel.constants';
import {
  baseModelByName,
  ecosystemById,
  isBaseModelGenerationSupported,
  SELF_HOSTED_ECOSYSTEM_KEYS,
} from '~/shared/constants/basemodel.constants';
import { getVisibleSystemWildcardSetIdsByVersionId } from '~/server/services/generation/version-generation-state.service';
import type {
  GenerationEcosystemConfig,
  GenerationEcosystemContext,
} from '~/server/schema/generation.schema';
import {
  DEFAULT_GENERATION_ECOSYSTEM_CONFIG,
  generationEcosystemConfigSchema,
} from '~/server/schema/generation.schema';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import {
  getBaseModelEngine,
  getBaseModelMediaType,
  getBaseModelsByGroup,
  getEcosystem,
  hasGenerationSupport,
  getResourceGenerationSupport,
} from '~/shared/constants/basemodel.constants';
import { mapDataToGraphInput } from '~/server/services/orchestrator/legacy-metadata-mapper';
import { cleanPrompt } from '~/utils/metadata/audit';

type GenerationResourceSimple = {
  id: number;
  name: string;
  trainedWords: string[];
  modelId: number;
  modelName: string;
  modelType: ModelType;
  baseModel: string;
  strength: number;
  minStrength: number;
  maxStrength: number;
  minor: boolean;
  sfwOnly: boolean;
  fileSizeKB: number;
  available: boolean;
};

type MetaCivitaiResource = { type?: string; weight?: number; modelVersionId: number };

/**
 * Build the initial resource list from image metadata: maps `civitaiResources`
 * to `{ modelVersionId, strength }` and adds the Wan checkpoint implied by the
 * baseModel. Relocated from the removed `normalize-meta.service` (the rest of
 * that service's normalization is now handled by `mapDataToGraphInput` + the
 * generation graph).
 */
function getMetaResources({
  baseModel,
  civitaiResources,
}: {
  baseModel?: string;
  civitaiResources?: MetaCivitaiResource[];
}) {
  const resources =
    civitaiResources?.map(({ weight, modelVersionId }) => ({
      modelVersionId: Number(modelVersionId),
      strength: weight,
    })) ?? [];

  // add missing resource by baseModel
  const modelVersionId = baseModel
    ? wanBaseModelGroupIdMap[baseModel as BaseModelGroup]
    : undefined;
  if (modelVersionId && !resources.find((x) => x.modelVersionId === modelVersionId)) {
    resources.push({ modelVersionId, strength: undefined });
  }
  return resources;
}

// const baseModelSetsArray = Object.values(baseModelSets);
/** @deprecated using search index instead... */
export const getGenerationResources = async (
  input: GetGenerationResourcesInput & { user?: SessionUser }
) => {
  return await getPagedData<GetGenerationResourcesInput, GenerationResourceSimple[]>(
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
        const baseModels = getBaseModelsByGroup(baseModel as BaseModelGroup);
        if (baseModels.length)
          sqlAnd.push(Prisma.sql`mv."baseModel" IN (${Prisma.join(baseModels, ',')})`);
      }

      let orderBy = 'mv.index';
      if (!query) orderBy = `mm."thumbsUpCount", ${orderBy}`;

      const results = await dbRead.$queryRaw<Array<GenerationResourceSimple & { index: number }>>`
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
          orderBy.startsWith('mm') ? `JOIN "ModelMetric" mm ON mm."modelId" = m.id` : ''
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
  const db = await getDbWithoutLag('modelVersion', id);
  const result = await db.generationCoverage.findFirst({
    where: { modelVersionId: id },
    select: { covered: true },
  });

  return (result?.covered ?? false) && unavailableGenResources.indexOf(id) === -1;
}

export async function getGenerationStatus() {
  // Fail open: a sysRedis outage shouldn't crash generation API calls.
  let raw: string | null | undefined;
  try {
    raw = await sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, REDIS_SYS_KEYS.GENERATION.STATUS);
  } catch (err) {
    logSysRedisFailOpen('defaults-firing', 'getGenerationStatus generation.service', err);
    raw = undefined;
  }
  const status = generationStatusSchema.parse(JSON.parse(raw ?? '{}'));

  return status as GenerationStatus;
}

export async function setGenerationStatus(input: {
  mode: GenerationStatusMode;
  message?: string | null;
  updatedBy: { id: number; username: string };
}) {
  // Read raw and throw on sysRedis error. We MUST NOT use the fail-open
  // getGenerationStatus() here: if its read failed open to '{}' and the
  // subsequent hSet succeeded, schema defaults (charge: true, limits:
  // defaultsByTier) would overwrite the real ops-tuned values. Fail-loud
  // is the right behavior for admin writes — the admin sees the 500 and
  // retries after sysRedis recovers.
  const raw = await sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, REDIS_SYS_KEYS.GENERATION.STATUS);
  const current = generationStatusSchema.parse(JSON.parse(raw ?? '{}'));
  const stamp = {
    id: input.updatedBy.id,
    username: input.updatedBy.username,
    at: new Date().toISOString(),
  };
  // Record the moderator when generation moves INTO a restricted mode
  // (memberOnly/disabled). Returning to 'enabled' preserves the prior stamp —
  // we don't care who re-enables.
  const restricting = input.mode !== 'enabled' && input.mode !== current.mode;
  const persisted = {
    mode: input.mode,
    // Persist the message independently of the mode: `undefined` (a mode-only
    // save) keeps the stored message; `null`/string is an explicit edit.
    message: input.message === undefined ? current.message : input.message,
    updatedBy: restricting ? stamp : current.updatedBy,
    // The self-hosted toggle is independent — carry it over untouched so a
    // global-mode write doesn't reset it (this object is persisted verbatim,
    // there's no spread of `current`).
    selfHostedMode: current.selfHostedMode,
    selfHostedUpdatedBy: current.selfHostedUpdatedBy,
    limits: current.limits,
    charge: current.charge,
  };
  await sysRedis.hSet(
    REDIS_SYS_KEYS.SYSTEM.FEATURES,
    REDIS_SYS_KEYS.GENERATION.STATUS,
    JSON.stringify(persisted)
  );
  return generationStatusSchema.parse(persisted);
}

/**
 * Self-hosted-toggle sibling of `setGenerationStatus`. Updates only the
 * `selfHostedMode` (+ audit stamp) and carries the global fields over
 * untouched. Same fail-loud rationale as `setGenerationStatus` (no fail-open
 * read). The self-hosted toggle has no message of its own.
 */
export async function setSelfHostedGenerationStatus(input: {
  mode: GenerationStatusMode;
  updatedBy: { id: number; username: string };
}) {
  const raw = await sysRedis.hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, REDIS_SYS_KEYS.GENERATION.STATUS);
  const current = generationStatusSchema.parse(JSON.parse(raw ?? '{}'));
  const stamp = {
    id: input.updatedBy.id,
    username: input.updatedBy.username,
    at: new Date().toISOString(),
  };
  const restricting = input.mode !== 'enabled' && input.mode !== current.selfHostedMode;
  const persisted = {
    // Preserve the global generation status untouched.
    mode: current.mode,
    message: current.message,
    updatedBy: current.updatedBy,
    // Update the self-hosted toggle.
    selfHostedMode: input.mode,
    selfHostedUpdatedBy: restricting ? stamp : current.selfHostedUpdatedBy,
    limits: current.limits,
    charge: current.charge,
  };
  await sysRedis.hSet(
    REDIS_SYS_KEYS.SYSTEM.FEATURES,
    REDIS_SYS_KEYS.GENERATION.STATUS,
    JSON.stringify(persisted)
  );
  return generationStatusSchema.parse(persisted);
}

export type RemixOfProps = {
  id?: number;
  url?: string;
  type: MediaType;
  similarity?: number;
  createdAt: Date;
};
/**
 * Generation data returned from the API.
 * Uses flat resources array + params format for storage compatibility.
 * Clients should use splitResourcesByType() to route resources to graph nodes.
 */
export type GenerationData = {
  type: MediaType;
  remixOfId?: number;
  remixOf?: RemixOfProps;
  /** Flat array of all resources (checkpoint, LoRAs, VAE, etc.) */
  resources: GenerationResource[];
  /** Generation parameters (prompt, seed, steps, etc.) */
  params: Record<string, unknown>;
};

export const getGenerationData = async ({
  query,
  user,
  sfwOnly = false,
}: {
  query: GetGenerationDataSchema;
  user?: SessionUser;
  sfwOnly?: boolean;
}): Promise<GenerationData> => {
  switch (query.type) {
    case 'image':
    case 'video':
      return await getMediaGenerationData({
        id: query.id,
        user,
        generation: query.generation,
        withPreview: query.withPreview,
        sfwOnly,
      });
    case 'modelVersion':
      return await getModelVersionGenerationData({
        versionIds: [{ id: query.id, epoch: query.epoch }],
        user,
        generation: query.generation,
        withPreview: query.withPreview,
        sfwOnly,
      });
    case 'modelVersions':
      return await getModelVersionGenerationData({
        user,
        versionIds: query.ids,
        generation: query.generation,
        withPreview: query.withPreview,
        sfwOnly,
      });
    default:
      throw new Error('unsupported generation data type');
  }
};

/**
 * Swaps any "cover" resources (those carrying an `aliasId` from
 * `meta.generationAlias`) for their target version's resource, preserving the
 * cover's strength. Used by the remix path, where image resources can include a
 * cover version that should redirect to its alias target before generation. A
 * target that no longer resolves is dropped (fail-closed). Results are deduped
 * by id in case the image already referenced the target directly.
 */
async function swapGenerationAliases(
  resources: (GenerationResource & { air: string })[],
  opts: {
    user?: { id?: number; isModerator?: boolean };
    generation?: boolean;
    withPreview?: boolean;
    sfwOnly?: boolean;
  }
): Promise<(GenerationResource & { air: string })[]> {
  const aliasIds = [...new Set(resources.map((r) => r.aliasId).filter(isDefined))];
  if (!aliasIds.length) return resources;

  const targets = await getResourceData(aliasIds, opts);
  const targetById = new Map(targets.map((t) => [t.id, t]));

  const swapped = resources
    .map((r) => {
      if (r.aliasId == null) return r;
      const target = targetById.get(r.aliasId);
      if (!target) return null;
      return { ...target, strength: r.strength };
    })
    .filter(isDefined);

  return uniqBy(swapped, 'id');
}

/**
 * Shared pre-normalization for the remix / generate-from-image paths
 * (`getMediaGenerationData` + `resolveImageMeta`):
 * - clean prompts (the mapper passes prompt/negativePrompt through raw)
 * - derive `process` from the legacy `type` field (the mapper keys workflow off `process`)
 * - resolve the ecosystem from baseModel, falling back to the checkpoint resource
 * - filter resources to the resolved ecosystem
 * - map the result to generation-graph params
 *
 * The mapper + generation graph handle everything else (workflow, images,
 * aspectRatio, and per-ecosystem version resolution — incl. Wan).
 */
function resolveGraphParamsFromImageMeta({
  initialMeta,
  baseModel,
  engine,
  allResources,
  width,
  height,
}: {
  initialMeta: ImageMetaProps;
  baseModel: string | undefined;
  engine: string | undefined;
  allResources: GenerationResource[];
  width: number;
  height: number;
}): { resources: GenerationResource[]; params: Record<string, unknown> } {
  const metaRecord = initialMeta as Record<string, unknown>;
  const cleanedPrompts = cleanPrompt({
    prompt: initialMeta.prompt,
    negativePrompt: initialMeta.negativePrompt,
  });
  const process =
    typeof metaRecord.type === 'string'
      ? (metaRecord.type as string)
      : (metaRecord.process as string | undefined);

  // If the ecosystem is 'other' or missing, try to infer from the checkpoint resource
  let ecosystem =
    (metaRecord.ecosystem as string | undefined) ??
    (baseModel ? getEcosystem(baseModel)?.key : undefined);
  if (!ecosystem || ecosystem === 'Other') {
    const checkpoint = allResources.find((x) => x.model.type === 'Checkpoint');
    if (checkpoint) {
      ecosystem = getEcosystem(checkpoint.baseModel)?.key;
    }
  }

  const resources = !ecosystem
    ? allResources
    : allResources.filter(
        (x) => !!getResourceGenerationSupport(ecosystem!, x.baseModel, x.model.type)
      );

  // Drop raw resource fields (handled separately via `resources`) and the legacy
  // `type` (consumed into `process`); the mapper strips the rest.
  const { civitaiResources: _cr, resources: _res, type: _t, ...restMeta } = metaRecord;
  const meta = {
    ...restMeta,
    ...cleanedPrompts,
    baseModel,
    engine,
    ecosystem,
    process,
  } as Record<string, unknown>;
  // Handle legacy 'Clip skip' field name (old image meta uses space-separated key)
  const clipSkip = meta.clipSkip ?? meta['Clip skip'] ?? undefined;
  const params = mapDataToGraphInput({ ...meta, width, height, clipSkip, engine }, resources);

  return { resources, params };
}

async function getMediaGenerationData({
  id,
  user,
  generation,
  withPreview = false,
  sfwOnly = false,
}: {
  id: number;
  user?: SessionUser;
  generation: boolean;
  withPreview?: boolean;
  sfwOnly?: boolean;
}): Promise<GenerationData> {
  const media = await dbRead.image.findUnique({
    where: { id },
    select: {
      id: true,
      type: true,
      url: true,
      meta: true,
      height: true,
      width: true,
      createdAt: true,
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
    createdAt: media.createdAt,
  };

  const initialMeta = (media.meta ?? {}) as ImageMetaProps;
  const imageResources = getMetaResources(initialMeta);

  await dbRead.imageResourceNew
    .findMany({
      where: { imageId: id },
      select: { modelVersionId: true, strength: true },
    })
    .then((res) => {
      for (const { modelVersionId, strength } of res) {
        const exists = imageResources.some((x) => x.modelVersionId === modelVersionId);
        if (!exists)
          imageResources.push({
            modelVersionId,
            strength: strength ? strength / 100 : undefined,
          });
      }
    });
  const versionIds = [...new Set(imageResources.map((x) => x.modelVersionId).filter(isDefined))];
  const allResources = await getResourceData(versionIds, {
    user,
    generation,
    withPreview,
    sfwOnly,
  })
    .then((data) =>
      data.map((item) => {
        const imageResource = imageResources.find((x) => x.modelVersionId === item.id);
        return {
          ...item,
          strength: imageResource?.strength ?? item.strength,
        };
      })
    )
    // Redirect any cover resources to their alias target (carrying the image's
    // recorded strength) before the data is used for the remix.
    .then((data) => swapGenerationAliases(data, { user, generation, withPreview, sfwOnly }));
  const baseModel = getBaseModelFromResources(
    allResources.map((x) => ({ modelType: x.model.type, baseModel: x.baseModel }))
  );

  const type = baseModel ? getBaseModelMediaType(baseModel) ?? media.type : media.type;
  const engine = initialMeta.engine ?? (baseModel ? getBaseModelEngine(baseModel) : undefined);

  const { resources, params } = resolveGraphParamsFromImageMeta({
    initialMeta,
    baseModel,
    engine,
    allResources,
    width,
    height,
  });

  if (type === 'audio') throw new Error('not implemented');

  // Return flat resources array - clients use splitResourcesByType() to route to graph nodes
  return {
    type,
    remixOfId: media.id, // TODO - remove
    remixOf,
    resources,
    params,
  };
}

/**
 * Reads the optional `meta.generationAlias` redirect for a set of model
 * versions, returning a map of sourceVersionId -> alias. Self-references are
 * ignored. Used by the generator-open path (to load the target instead of the
 * cover version) and by `resolveCanGenerateForVersions` (to derive the cover
 * version's coverage from its target — fail-closed).
 */
async function getGenerationAliasMap(versionIds: number[]): Promise<Map<number, GenerationAlias>> {
  const ids = [...new Set(versionIds)];
  if (!ids.length) return new Map();
  const rows = await dbRead.modelVersion.findMany({
    where: { id: { in: ids } },
    select: { id: true, meta: true },
  });
  const map = new Map<number, GenerationAlias>();
  for (const row of rows) {
    const alias = (row.meta as ModelVersionMeta | null)?.generationAlias;
    if (alias?.versionId && alias.versionId !== row.id) map.set(row.id, alias);
  }
  return map;
}

/**
 * Expands versions into the gate inputs used for canGenerate, with generation
 * aliases resolved: an aliased cover version is replaced by its target's gate
 * fields while the result key stays the cover id. A missing target (deleted)
 * falls back to the cover's own (uncovered) fields, which fail closed.
 */
async function resolveAliasGateVersions(
  versions: ResolveCanGenerateVersion[],
  aliasMap: Map<number, GenerationAlias>
): Promise<{ key: number; gate: ResolveCanGenerateVersion }[]> {
  if (!aliasMap.size) return versions.map((v) => ({ key: v.id, gate: v }));

  const targetIds = [...new Set([...aliasMap.values()].map((a) => a.versionId))];
  const rows = await dbRead.modelVersion.findMany({
    where: { id: { in: targetIds } },
    select: {
      id: true,
      status: true,
      availability: true,
      usageControl: true,
      baseModel: true,
      generationCoverage: { select: { covered: true } },
      model: { select: { userId: true, type: true } },
    },
  });
  const targetById = new Map<number, ResolveCanGenerateVersion>(
    rows.map(({ generationCoverage, model, usageControl, ...rest }) => [
      rest.id,
      {
        ...rest,
        usageControl: usageControl ?? undefined,
        covered: generationCoverage?.covered ?? null,
        modelUserId: model.userId,
        modelType: model.type,
      },
    ])
  );

  return versions.map((v) => {
    const alias = aliasMap.get(v.id);
    const gate = alias ? targetById.get(alias.versionId) : undefined;
    return { key: v.id, gate: gate ?? v };
  });
}

const getModelVersionGenerationData = async ({
  versionIds,
  user,
  generation,
  withPreview = false,
  sfwOnly = false,
}: {
  versionIds: { id: number; epoch?: number }[] | number[];
  user?: SessionUser;
  generation: boolean;
  withPreview?: boolean;
  sfwOnly?: boolean;
}): Promise<GenerationData> => {
  if (!versionIds.length) throw new Error('missing version ids');

  // Normalize to objects so alias redirects can drop the requested epoch — the
  // alias points at a published target, not a training checkpoint of the cover.
  const requested =
    typeof versionIds[0] === 'number'
      ? (versionIds as number[]).map((id) => ({ id }))
      : (versionIds as { id: number; epoch?: number }[]);

  // Generation alias: opening a cover version loads its target version's
  // resource instead (1:1 redirect). Any per-alias strength is applied after
  // fetch. The Create button is gated on the target's coverage upstream
  // (resolveCanGenerateForVersions), so a dead target can't be reached here.
  const aliasMap = await getGenerationAliasMap(requested.map((x) => x.id));
  const aliasStrengthByTarget = new Map<number, number>();
  const resolvedVersionIds = requested.map((x) => {
    const alias = aliasMap.get(x.id);
    if (!alias) return x;
    if (alias.strength != null) aliasStrengthByTarget.set(alias.versionId, alias.strength);
    return { id: alias.versionId };
  });

  const resources = await getResourceData(resolvedVersionIds, {
    user,
    generation,
    withPreview,
    sfwOnly,
  });

  // Apply alias strength overrides to the redirected resources.
  if (aliasStrengthByTarget.size) {
    for (const resource of resources) {
      const strength = aliasStrengthByTarget.get(resource.id);
      if (strength != null) resource.strength = strength;
    }
  }
  const checkpoint = resources.find((x) => x.model.type === 'Checkpoint');
  // Resolve VAE from linked components instead of vaeId
  if (checkpoint) {
    const vaeMap = await getLinkedVaeIds([checkpoint.id]);
    const vaeVersionId = vaeMap.get(checkpoint.id);
    if (vaeVersionId) {
      const [vae] = await getResourceData([vaeVersionId], { user, generation });
      if (vae) resources.push({ ...vae, vaeId: undefined });
    }
  }

  const deduped = uniqBy(resources, 'id');

  // Build params from checkpoint settings
  const params = mapDataToGraphInput(
    {
      clipSkip: checkpoint?.clipSkip,
    },
    deduped
  );

  // Return flat resources array - clients use splitResourcesByType() to route to graph nodes
  // mapDataToGraphInput returns `ecosystem` (not `baseModel`), so resolve the
  // media type from the ecosystem key — getBaseModelMediaType accepts both.
  return {
    type: getBaseModelMediaType(params.ecosystem as string) ?? 'image',
    resources: deduped,
    params,
  };
};

export async function getUnstableResources() {
  const cachedData = await sysRedis
    .hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, 'generation:unstable-resources')
    .then((data) => (data ? fromJson<number[]>(data) : ([] as number[])))
    .catch(() => [] as number[]); // fallback to empty array if redis fails

  return cachedData ?? [];
}

/**
 * Loads the operator-set ecosystem config (now just `experimentalEcosystems` —
 * an alert flag, not a gate) from Redis and resolves the `generation-testing`
 * Flipt flag for the given user in parallel. `hasTestingAccess` is still needed
 * to resolve the `testers` tier of the gate rules.
 *
 * Mods are always treated as having testing access. Pass an empty user
 * object for unauthenticated/anonymous calls — `hasTestingAccess` will be
 * `false`.
 */
export async function getGenerationEcosystemConfig(
  user: { id?: number; isModerator?: boolean } = {}
): Promise<GenerationEcosystemContext> {
  const [cached, hasTestingAccess] = await Promise.all([
    sysRedis
      .hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, 'generation:ecosystem-config')
      .then((data) => (data ? fromJson<Partial<GenerationEcosystemConfig>>(data) : null))
      .catch(() => null), // fallback to default if redis fails
    resolveTestingAccess(user),
  ]);

  // Parse fills any missing fields with their schema defaults; on a corrupt
  // value fall back to the default (fail-open).
  const parsed = generationEcosystemConfigSchema.safeParse(cached ?? {});
  return {
    ...(parsed.success ? parsed.data : DEFAULT_GENERATION_ECOSYSTEM_CONFIG),
    hasTestingAccess,
  };
}

async function resolveTestingAccess(user: {
  id?: number;
  isModerator?: boolean;
}): Promise<boolean> {
  if (user.isModerator) return true;
  if (!user.id) return false;
  return isFlipt(FLIPT_FEATURE_FLAGS.GENERATION_TESTING, String(user.id), {
    isModerator: 'false',
  });
}

/**
 * Persists the operator-set ecosystem gating config to Redis. Used by the
 * moderator UI at `/moderator/generation-config`. The shape matches
 * `GenerationEcosystemConfig`; arrays are written as-is, no merging with
 * the previous value, so the form is the single source of truth for what
 * gets stored.
 */
export async function setGenerationEcosystemConfig(input: GenerationEcosystemConfig) {
  await sysRedis.hSet(REDIS_SYS_KEYS.SYSTEM.FEATURES, 'generation:ecosystem-config', toJson(input));
  return input;
}

const gateRulesArraySchema = z.array(gateRuleSchema);

/**
 * The operator-authored gate rules (the normalized "rules" model). Stored as a
 * single JSON array under `generation:gate-rules`; starts empty and coexists
 * with the legacy `generation:ecosystem-config` lists + self-hosted toggle.
 * Fail-open to `[]` so a bad/missing value never blocks generation.
 */
export async function getGateRules(): Promise<GateRule[]> {
  const cached = await sysRedis
    .hGet(REDIS_SYS_KEYS.SYSTEM.FEATURES, 'generation:gate-rules')
    .then((data) => (data ? fromJson<GateRule[]>(data) : null))
    .catch(() => null);
  const parsed = gateRulesArraySchema.safeParse(cached ?? []);
  return parsed.success ? parsed.data : [];
}

/** Persists the full gate-rules array. The mod UI is the single source of truth. */
export async function setGateRules(rules: GateRule[]): Promise<GateRule[]> {
  const parsed = gateRulesArraySchema.parse(rules);
  await sysRedis.hSet(REDIS_SYS_KEYS.SYSTEM.FEATURES, 'generation:gate-rules', toJson(parsed));
  return parsed;
}

export type GenerationConfig = {
  unstableResources: number[];
  /**
   * Ecosystem keys that should display the "experimental build" alert in
   * the generator UI. Surfaced to the client so `ExperimentalModelAlert`
   * can union this list with the static `isEcosystemExperimental` check.
   */
  experimentalEcosystems: string[];
  /**
   * Self-hosted ecosystem keys disabled FOR THIS USER, resolved against the
   * `selfHostedMode` toggle + the user's membership/mod status. Shown-but-disabled
   * in the picker. Empty when self-hosted generation is enabled for the user.
   */
  selfHostedDisabledEcosystems: string[];
  /**
   * The raw self-hosted toggle state, surfaced so the client can pick the
   * right badge/alert copy ('memberOnly' → upsell, 'disabled' → unavailable).
   */
  selfHostedMode: GenerationStatusMode;
  /**
   * The gate rules that apply to THIS user (already audience-filtered server
   * side). Ride into `GenerationCtx` so the graph nodes resolve them to per-item
   * `hidden`/`disabled`/`memberOnly` states — the audience logic never leaves
   * the server.
   */
  gateRules: GateRule[];
};

/**
 * Pure resolver for the self-hosted toggle. Returns the ecosystem keys the
 * given user can't use right now. Shared by `getGenerationConfig` (client UI)
 * and `buildGenerationContext` (server-side graph validation) so both agree.
 *
 *  - moderators always bypass → `[]`
 *  - `disabled` → the full self-hosted set (off for everyone)
 *  - `memberOnly` → the full set for non-members, `[]` for members
 *  - `enabled` → `[]`
 */
export function getSelfHostedDisabledEcosystems({
  selfHostedMode,
  isMember,
  isModerator,
}: {
  selfHostedMode: GenerationStatusMode;
  isMember: boolean;
  isModerator?: boolean;
}): string[] {
  if (isModerator) return [];
  const blocked = selfHostedMode === 'disabled' || (selfHostedMode === 'memberOnly' && !isMember);
  return blocked ? [...SELF_HOSTED_ECOSYSTEM_KEYS] : [];
}

/**
 * Composed config returned to clients in a single round-trip. Bundles unstable
 * resources (set by the `resource-gen-availability` cron), the experimental-
 * ecosystem alert list, the self-hosted toggle state, and the user's applicable
 * gate rules — everything the generator UI needs in one query.
 */
export async function getGenerationConfig(
  user: { id?: number; isModerator?: boolean; tier?: string } = {}
): Promise<GenerationConfig> {
  const [unstableResources, ecosystemConfig, status, gateRules] = await Promise.all([
    getUnstableResources(),
    getGenerationEcosystemConfig(user),
    getGenerationStatus(),
    getGateRules(),
  ]);
  const selfHostedMode = status.selfHostedMode;
  const isMember = (user.tier ?? 'free') !== 'free';
  return {
    unstableResources,
    experimentalEcosystems: ecosystemConfig.experimentalEcosystems,
    selfHostedMode,
    selfHostedDisabledEcosystems: getSelfHostedDisabledEcosystems({
      selfHostedMode,
      isMember,
      isModerator: user.isModerator,
    }),
    gateRules: applicableRulesFor(gateRules, {
      isModerator: !!user.isModerator,
      isMember,
      hasTestingAccess: ecosystemConfig.hasTestingAccess,
    }),
  };
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

const FREE_RESOURCE_TYPES: ModelType[] = ['VAE', 'Checkpoint'];
export async function getShouldChargeForResources(
  args: {
    modelType: ModelType;
    modelId: number;
    fileSizeKB?: number;
  }[]
) {
  const featuredModels = await getFeaturedModels();
  return args.reduce<Record<string, boolean>>(
    (acc, { modelType, modelId, fileSizeKB }) => ({
      ...acc,
      [modelId]: fileSizeKB
        ? !FREE_RESOURCE_TYPES.includes(modelType) &&
          !featuredModels.map((fm) => fm.modelId).includes(modelId) &&
          fileSizeKB > 10 * 1024
        : false,
    }),
    {}
  );
}

const explicitCoveredModelAirs = [fluxUltraAir, ponyV7Air];
const explicitCoveredModelVersionIds = explicitCoveredModelAirs.map((air) => parseAIR(air).version);

/** The `hidden` gate targets for the site-wide `canGenerate` check. */
export type CanGenerateHiddenGates = { ecosystems: Set<string>; versionIds: Set<number> };

/**
 * Resolve the ecosystems / version IDs the gate rules HIDE for this user — the
 * only state that hard-blocks `canGenerate` (disabled / members-only are
 * generator-UI affordances, not a site-wide block). Membership is intentionally
 * ignored here (no tier lookup): `isMember: true` drops member-restricted rules,
 * leaving the moderator / tester / kill-switch / hidden rules, which need only
 * the (already-resolved) testing-access flag + mod status.
 */
export async function getCanGenerateHiddenGates(user: {
  id?: number;
  isModerator?: boolean;
}): Promise<CanGenerateHiddenGates> {
  const [rules, hasTestingAccess] = await Promise.all([getGateRules(), resolveTestingAccess(user)]);
  const states = rulesToStates(
    applicableRulesFor(rules, {
      isModerator: !!user.isModerator,
      isMember: true,
      hasTestingAccess,
    })
  );
  const ecosystems = new Set<string>();
  for (const [key, r] of states.ecosystems) if (r.state === 'hidden') ecosystems.add(key);
  const versionIds = new Set<number>();
  for (const [id, r] of states.modelVersionIds) if (r.state === 'hidden') versionIds.add(id);
  return { ecosystems, versionIds };
}

/**
 * Single source of truth for deciding whether a resource can be used for
 * generation. Mirrors the checks in `transformGenerationData` so callers
 * outside of `getResourceData` (e.g. `getModelHandler`) can stay in sync.
 */
export function getResourceCanGenerate({
  resource,
  user,
  unavailableResources,
  hiddenGates,
}: {
  resource: {
    id: number;
    status: string;
    availability: string;
    usageControl?: string;
    baseModel: string;
    covered: boolean | null;
    modelUserId: number;
  };
  user: { id?: number; isModerator?: boolean };
  unavailableResources: number[];
  hiddenGates: CanGenerateHiddenGates;
}): boolean {
  const isUnavailable = unavailableResources.includes(resource.id);
  const isOwnedByUser = !!user.id && user.id === resource.modelUserId;
  const covered =
    (resource.covered || explicitCoveredModelVersionIds.includes(resource.id)) && !isUnavailable;

  const validGenerationStatuses = ['Draft', 'Training', 'Published'];
  const hasValidStatus = validGenerationStatuses.includes(resource.status);
  const isPrivate =
    resource.availability === 'Private' || ['Draft', 'Training'].includes(resource.status);

  let canGenerate = !!(
    covered &&
    hasValidStatus &&
    (!isPrivate || isOwnedByUser || user.isModerator)
  );

  if (resource.usageControl === 'InternalGeneration' && !user.isModerator) {
    canGenerate = false;
  }

  if (canGenerate) {
    const baseModel = baseModelByName.get(resource.baseModel);
    const ecosystemKey = baseModel ? ecosystemById.get(baseModel.ecosystemId)?.key : undefined;
    if (
      hiddenGates.versionIds.has(resource.id) ||
      (ecosystemKey && hiddenGates.ecosystems.has(ecosystemKey))
    ) {
      canGenerate = false;
    }
  }

  return canGenerate;
}

/**
 * Resolve `canGenerate` for a batch of ModelVersions, routing through the
 * appropriate gate per `modelType`:
 *
 *   - `Wildcards`-type versions: gated on a visible System-kind `WildcardSet`
 *     (one batched query via `getVisibleSystemWildcardSetIdsByVersionId`),
 *     since their baseModel isn't on the generation-supported list.
 *   - Everything else: the standard `getResourceCanGenerate` +
 *     `isBaseModelGenerationSupported` pair.
 *
 * Fetches `unavailableResources` + `ecosystemConfig` internally so call sites
 * don't have to thread them through. Returns a Map keyed by `modelVersionId`;
 * the `wildcardSetId` field is populated only for Wildcards-type entries
 * whose set is visible at the current site context.
 *
 * Replaces the per-call-site "branch on model.type + maybe batch + override"
 * boilerplate that the four canGenerate read paths used to repeat.
 */
export type ResolveCanGenerateVersion = {
  id: number;
  status: string;
  availability: string;
  usageControl?: string;
  baseModel: string;
  covered: boolean | null | undefined;
  modelUserId: number;
  modelType: ModelType;
  /**
   * Generation alias from `meta.generationAlias`, supplied by the caller (which
   * already has the version's meta). When set, this version's canGenerate is
   * derived from the target version instead — fail-closed.
   */
  modelVersionAlias?: GenerationAlias | null;
};

export type ResolveCanGenerateContext = {
  user: { id?: number; isModerator?: boolean };
  sfwOnly: boolean;
  wildcardsEnabled: boolean;
};

export type VersionGenerationState = {
  canGenerate: boolean;
  wildcardSetId?: number;
};

export async function resolveCanGenerateForVersions(
  versions: ResolveCanGenerateVersion[],
  ctx: ResolveCanGenerateContext
): Promise<Map<number, VersionGenerationState>> {
  const wildcardVersionIds = ctx.wildcardsEnabled
    ? versions.filter((v) => v.modelType === 'Wildcards').map((v) => v.id)
    : [];

  const needsStandardGate = versions.some((v) => v.modelType !== 'Wildcards');
  const [visibleWildcardSetIdByVersionId, unavailableResources, hiddenGates] = await Promise.all([
    getVisibleSystemWildcardSetIdsByVersionId(wildcardVersionIds, { sfwOnly: ctx.sfwOnly }),
    needsStandardGate ? getUnavailableResources() : Promise.resolve<number[]>([]),
    needsStandardGate
      ? getCanGenerateHiddenGates(ctx.user)
      : Promise.resolve<CanGenerateHiddenGates>({ ecosystems: new Set(), versionIds: new Set() }),
  ]);

  // Generation alias (Option B): evaluate a cover version using its target's
  // gate fields while keeping the result keyed to the cover id, so the Create
  // button fails closed when the target is deleted/unpublished/uncovered.
  // Aliases come from `version.modelVersionAlias` (caller-supplied). One-level
  // only — a target that is itself an alias is not followed.
  const aliasMap = new Map<number, GenerationAlias>();
  for (const v of versions) {
    const alias = v.modelVersionAlias;
    if (alias?.versionId && alias.versionId !== v.id) aliasMap.set(v.id, alias);
  }
  const gateVersions = await resolveAliasGateVersions(versions, aliasMap);

  const result = new Map<number, VersionGenerationState>();
  for (const { key, gate } of gateVersions) {
    if (gate.modelType === 'Wildcards') {
      // Wildcards baseModels aren't on the generation-supported list, so the
      // standard gate always returns false for them. A visible System-kind
      // set is the only way canGenerate can be true.
      const wildcardSetId = visibleWildcardSetIdByVersionId.get(gate.id);
      result.set(key, { canGenerate: wildcardSetId != null, wildcardSetId });
    } else {
      const canGenerate =
        getResourceCanGenerate({
          resource: {
            id: gate.id,
            status: gate.status,
            availability: gate.availability,
            usageControl: gate.usageControl,
            baseModel: gate.baseModel,
            covered: gate.covered ?? null,
            modelUserId: gate.modelUserId,
          },
          user: ctx.user,
          unavailableResources,
          hiddenGates,
        }) && isBaseModelGenerationSupported(gate.baseModel, gate.modelType);
      result.set(key, { canGenerate });
    }
  }

  return result;
}

export async function getResourceData(
  versionIds: { id: number; epoch?: number }[] | number[],
  {
    user = {},
    generation = false,
    withPreview = false,
    sfwOnly = false,
  }: {
    user?: { id?: number; isModerator?: boolean };
    generation?: boolean;
    withPreview?: boolean;
    sfwOnly?: boolean;
  } = {}
): Promise<(GenerationResource & { air: string })[]> {
  if (!versionIds.length) return [];
  const args = (
    typeof versionIds[0] === 'number' ? versionIds.map((id) => ({ id })) : versionIds
  ) as { id: number; epoch?: number }[];

  const unavailableResources = await getUnavailableResources();
  const featuredModels = await getFeaturedModels();
  const hiddenGates = await getCanGenerateHiddenGates(user);

  function transformGenerationData(
    { settings, ...item }: GenerationResourceDataModel,
    epochNumber?: number
  ) {
    const isOwnedByUser = !!user.id && user.id === item.model.userId;
    const hasAccess = !!(item.hasAccess || isOwnedByUser || user.isModerator);
    const isPrivate =
      item.availability === 'Private' || ['Draft', 'Training'].includes(item.status);

    const canGenerate = getResourceCanGenerate({
      resource: {
        id: item.id,
        status: item.status,
        availability: item.availability,
        usageControl: item.usageControl,
        baseModel: item.baseModel,
        covered: item.covered,
        modelUserId: item.model.userId,
      },
      user,
      unavailableResources,
      hiddenGates,
    });

    if (!canGenerate) {
      // Delete these items so that the client doesn't have to notify users about these props. They are irrelevant if the resource cannot be used for generation.
      delete item.model.sfwOnly;
      delete item.model.minor;
    }

    return {
      ...item,
      minStrength: settings?.minStrength ?? -1,
      maxStrength: settings?.maxStrength ?? 2,
      strength: settings?.strength ?? 1,
      hasAccess,
      canGenerate,
      epochNumber,
      isOwnedByUser,
      isPrivate,
    };
  }

  async function getResourceDataSubstitutes(
    resources: ReturnType<typeof transformGenerationData>[]
  ) {
    const modelIdsThatRequireSubstitutes = resources
      .filter((x) => !x.covered || !x.hasAccess)
      .map((x) => x.model.id);

    const substituteDb = await getDbWithoutLagBatch('model', modelIdsThatRequireSubstitutes);
    const substituteIds = await substituteDb.modelVersion
      .findMany({
        where: {
          status: 'Published',
          generationCoverage: { covered: true },
          modelId: { in: modelIdsThatRequireSubstitutes },
        },
        orderBy: { index: { sort: 'asc', nulls: 'last' } },
        select: { id: true, baseModel: true, modelId: true },
      })
      .then((data) =>
        data
          .filter((x) => {
            const match = resources.find((resource) => resource.model.id === x.modelId);
            return match?.baseModel === x.baseModel;
          })
          .map((x) => x.id)
      );

    return await resourceDataCache
      .fetch(substituteIds)
      .then((data) => data.map((item) => transformGenerationData(item)));
  }

  async function getEntityAccess(resources: ReturnType<typeof transformGenerationData>[]) {
    const earlyAccessIds = resources
      .filter(
        (x) =>
          x.covered &&
          !x.hasAccess &&
          x.earlyAccessConfig &&
          // Free generation will technically bypass access checks, but we still want to show the early access badge
          !x.earlyAccessConfig.freeGeneration
      )
      .map((x) => x.id);

    return user.id
      ? await hasEntityAccess({
          entityType: 'ModelVersion',
          entityIds: earlyAccessIds,
          userId: user.id,
          isModerator: user.isModerator,
          permissions: EntityAccessPermission.EarlyAccessGeneration,
        })
      : [];
  }

  async function getModelFiles(resources: ReturnType<typeof transformGenerationData>[]) {
    const versionIds = resources.filter((x) => x.hasAccess).map((x) => x.id);
    return await getFilesForModelVersionCache(versionIds);
  }

  function getEpochDetails(
    resource: ReturnType<typeof transformGenerationData>,
    modelFiles: ModelFileCached[]
  ) {
    if (resource.status !== 'Published') {
      const trainingFile = modelFiles.find((f) => f.type === 'Training Data');
      if (trainingFile) {
        const details = getTrainingFileEpochNumberDetails(trainingFile, resource.epochNumber);
        if (!details?.isExpired) {
          return details;
        }
      }
    }
    delete resource.epochNumber;

    return null;
  }

  function getModelFileProps(
    resource: ReturnType<typeof transformGenerationData>,
    modelFiles: ModelFileCached[]
  ) {
    const primaryFile = getPrimaryFile(modelFiles);
    const fileSizeKB = primaryFile?.sizeKB;
    const featured = !!featuredModels.find((x) => x.modelId === resource.model.id);
    let additionalResourceCost = true;
    if (
      featured ||
      FREE_RESOURCE_TYPES.includes(resource.model.type) ||
      (fileSizeKB && fileSizeKB <= 10 * 1024)
    ) {
      additionalResourceCost = false;
    }

    const epochDetails = getEpochDetails(resource, modelFiles);

    return {
      fileSizeKB: fileSizeKB ? Math.round(fileSizeKB) : undefined,
      additionalResourceCost,
      epochDetails,
    };
  }

  function bringItAllTogether(
    resource: ReturnType<typeof transformGenerationData>,
    modelFiles: ModelFileCached[]
  ) {
    const { fileSizeKB, additionalResourceCost, epochDetails } = getModelFileProps(
      resource,
      modelFiles
    );
    const air = stringifyAIR({
      baseModel: resource.baseModel,
      type: resource.model.type,
      modelId: epochDetails ? epochDetails.jobId : resource.model.id,
      id: epochDetails ? epochDetails.fileName : resource.id,
      source: epochDetails ? 'orchestrator' : 'civitai',
    });

    return { ...resource, fileSizeKB, additionalResourceCost, epochDetails, air };
  }

  function getSubstituteData(
    resource: ReturnType<typeof transformGenerationData>,
    substitutes: ReturnType<typeof transformGenerationData>[],
    modelFiles: ModelFileCached[]
  ) {
    const substitute = substitutes.find((x) => x.hasAccess && x.model.id === resource.model.id);
    if (substitute) {
      const { model, ...rest } = bringItAllTogether(substitute, modelFiles);
      return removeNulls({ ...rest, ...getModelFileProps(substitute, modelFiles) });
    }
  }

  // Expand cache results to produce one entry per unique (id, epoch) pair.
  // The cache deduplicates by model version ID, but different epochs of the same
  // model version need separate entries with their own epochDetails.
  const uniqueIds = [...new Set(args.map((x) => x.id))];
  const resources = await resourceDataCache
    .fetch(uniqueIds)
    .then((cachedResources) => {
      const resourceById = new Map(cachedResources.map((r) => [r.id, r]));
      return args
        .map((arg) => {
          const cached = resourceById.get(arg.id);
          if (!cached) return null;
          return transformGenerationData(cached, arg.epoch);
        })
        .filter(isDefined);
    })
    .then(async (resources) => {
      const substitutes = await getResourceDataSubstitutes(resources);
      const entityAccess = await getEntityAccess([...resources, ...substitutes]);

      for (const resource of [...resources, ...substitutes]) {
        if (!resource.hasAccess) {
          // TODO - get the number of remaining early access downloads if early access allows limited number of free generations
          resource.hasAccess = !!(
            entityAccess.find((e) => e.entityId === resource.id)?.hasAccess ||
            !!resource.earlyAccessConfig?.generationTrialLimit
          );
          resource.canGenerate = resource.hasAccess && resource.canGenerate;
        }
      }

      const modelFilesCached = await getModelFiles([...resources, ...substitutes]);

      return resources.map((resource) => {
        const modelFiles = modelFilesCached[resource.id]?.files ?? [];
        const substitute = getSubstituteData(resource, substitutes, modelFiles);
        return removeNulls({ ...bringItAllTogether(resource, modelFiles), substitute });
      });
    });

  if (withPreview) {
    const imageCache = await imagesForModelVersionsCache.fetch(resources.map((r) => r.id));
    for (const resource of resources as (GenerationResource & { air: string })[]) {
      const images = imageCache[resource.id]?.images ?? [];
      const first = sfwOnly
        ? images.find((i) => Flags.intersects(i.nsfwLevel, sfwBrowsingLevelsFlag))
        : images[0];
      if (first) {
        resource.image = {
          id: first.id,
          url: first.url,
          width: first.width,
          height: first.height,
          hash: first.hash,
          type: first.type,
          nsfwLevel: first.nsfwLevel,
        };
      }
    }
  }

  // TODO - check if resource id is in "EcosystemCheckpoint" table
  // Note: `hasGenerationSupport` returns false for Wildcards-type baseModels
  // (Wildcards aren't generation resources), so the `generation: true` filter
  // here strips them out unless the caller is asking for unfiltered data
  // (e.g. the model detail page wants to render a Wildcards model's
  // "Generate" button enabled when the wildcard set is visible).
  //
  // Aliased "cover" resources are kept even when their own baseModel isn't
  // gen-supported: their generatability is derived from the alias target, and
  // consumers swap them for that (gen-supported) target via
  // `swapGenerationAliases`. Filtering here would strip the cover before the
  // swap could happen.
  const filtered = generation
    ? resources.filter(
        (resource) => hasGenerationSupport(resource.baseModel) || resource.aliasId != null
      )
    : resources;

  return filtered;
}

// =============================================================================
// Resolve Resources from Metadata
// =============================================================================

const EMPTY_HASH = 'e3b0c44298fc';

type HashCandidate = {
  hash: string;
  name: string;
  strength: number | null;
};

type ResolvedCandidate = {
  modelVersionId: number;
  strength: number | null;
};

/**
 * Extract resource-identification fields from raw EXIF metadata.
 * Returns a normalized shape for hash resolution + civitaiResources.
 */
function extractResourceInputFromMeta(metadata: Record<string, unknown>) {
  const resources = metadata.resources as
    | { name?: string; type?: string; hash?: string; weight?: number; modelVersionId?: number }[]
    | undefined;
  const hashes = metadata.hashes as Record<string, string> | undefined;
  const modelHash = (metadata['Model hash'] ?? metadata.modelHash) as string | undefined;
  const modelName = (metadata['Model'] ?? metadata.modelName) as string | undefined;
  const civitaiResources = metadata.civitaiResources as
    | { type?: string; weight?: number; modelVersionId: number }[]
    | undefined;

  // Merge resources with explicit modelVersionId into civitaiResources
  const idResources = Array.isArray(resources)
    ? resources
        .filter((r): r is typeof r & { modelVersionId: number } => !!r.modelVersionId)
        .map((r) => ({
          type: r.type,
          weight: r.weight ?? ((r as Record<string, unknown>).strength as number | undefined),
          modelVersionId: r.modelVersionId,
        }))
    : [];
  const allCivitaiResources = [...(civitaiResources ?? []), ...idResources];

  return {
    resources: Array.isArray(resources) ? resources.filter((r) => r.hash) : undefined,
    hashes,
    modelHash,
    modelName,
    civitaiResources: allCivitaiResources.length > 0 ? allCivitaiResources : undefined,
  };
}

/**
 * Extract hash candidates from metadata (mirrors get_image_resources.sql stages 1-3).
 */
function extractHashCandidates(
  input: ReturnType<typeof extractResourceInputFromMeta>
): HashCandidate[] {
  const candidates: HashCandidate[] = [];

  // Stage 1: meta.resources[] — resources with hashes
  if (input.resources) {
    for (const r of input.resources) {
      if (!r.hash || r.name === 'vae') continue;
      const hash = r.hash.toLowerCase();
      if (hash === EMPTY_HASH) continue;
      candidates.push({
        hash,
        name: r.name ?? r.type ?? 'unknown',
        strength: r.weight != null ? Math.round(r.weight * 100) : null,
      });
    }
  }

  // Stage 2: meta.hashes — key-value pairs (e.g. {"lora:name": "abc123"})
  if (input.hashes) {
    for (const [key, value] of Object.entries(input.hashes)) {
      if (key === 'vae') continue;
      const hash = value.toLowerCase();
      if (hash === EMPTY_HASH) continue;
      candidates.push({ hash, name: key, strength: null });
    }
  }

  // Stage 3: Legacy 'Model hash' field (only if no hashes object)
  if (input.modelHash && !input.hashes) {
    const hash = input.modelHash.toLowerCase();
    if (hash !== EMPTY_HASH) {
      candidates.push({ hash, name: input.modelName ?? 'model', strength: null });
    }
  }

  return candidates;
}

/**
 * Resolve resources from raw image EXIF metadata and transform to graph-compatible params.
 *
 * Mirrors the logic of get_image_resources.sql for resource resolution, then applies
 * the same pre-normalize → mapDataToGraphInput pipeline as getMediaGenerationData.
 *
 * Returns { resources, params } where params are ready for the generation graph.
 */
export async function resolveImageMeta({
  input,
  user,
  sfwOnly = false,
}: {
  input: ResolveImageMetaInput;
  user?: SessionUser;
  sfwOnly?: boolean;
}): Promise<{ resources: GenerationResource[]; params: Record<string, unknown> }> {
  const metadata = input.metadata;
  const resourceInput = extractResourceInputFromMeta(metadata);
  const resolved = new Map<number, ResolvedCandidate>();

  // --- Hash resolution (stages 1-3) ---
  const hashCandidates = extractHashCandidates(resourceInput);
  const uniqueHashes = [...new Set(hashCandidates.map((c) => c.hash))];

  if (uniqueHashes.length > 0) {
    // Batch query: hash → ModelFileHash → ModelFile → ModelVersion
    // Same JOIN chain as get_image_resources.sql lines 98-104
    const hashResults = await dbRead.$queryRaw<
      Array<{
        hash: string;
        modelVersionId: number;
        fileId: number;
        versionPublished: boolean;
        versionDate: Date;
        excludeFromAutoDetection: boolean;
      }>
    >`
      SELECT
        LOWER(mfh.hash::text) AS hash,
        mf."modelVersionId",
        mf.id AS "fileId",
        mv.status = 'Published' AS "versionPublished",
        COALESCE(mv."publishedAt", mv."createdAt") AS "versionDate",
        COALESCE(mv.meta->>'excludeFromAutoDetection', '') != '' AS "excludeFromAutoDetection"
      FROM "ModelFileHash" mfh
      JOIN "ModelFile" mf ON mf.id = mfh."fileId"
      JOIN "ModelVersion" mv ON mv.id = mf."modelVersionId"
      JOIN "Model" m ON m.id = mv."modelId"
      WHERE mfh.hash IN (${Prisma.join(uniqueHashes)})
        AND m.status NOT IN ('Deleted', 'Unpublished', 'UnpublishedViolation')
    `;

    // Build a map of hash → best matching modelVersionId
    // When multiple files match the same hash, prefer published > recent > lowest fileId
    const bestByHash = new Map<string, (typeof hashResults)[0]>();
    for (const row of hashResults) {
      if (row.excludeFromAutoDetection) continue;
      const existing = bestByHash.get(row.hash);
      if (
        !existing ||
        (!existing.versionPublished && row.versionPublished) ||
        (existing.versionPublished === row.versionPublished &&
          row.versionDate > existing.versionDate) ||
        (existing.versionPublished === row.versionPublished &&
          existing.versionDate === row.versionDate &&
          row.fileId < existing.fileId)
      ) {
        bestByHash.set(row.hash, row);
      }
    }

    // Match hash candidates to resolved version IDs
    for (const candidate of hashCandidates) {
      const match = bestByHash.get(candidate.hash);
      if (!match) continue;

      const existing = resolved.get(match.modelVersionId);
      // Prefer entries with strength info (mirrors SQL's IIF(strength IS NOT NULL,0,1))
      if (!existing || (existing.strength == null && candidate.strength != null)) {
        resolved.set(match.modelVersionId, {
          modelVersionId: match.modelVersionId,
          strength: candidate.strength,
        });
      }
    }
  }

  // --- Direct civitaiResources (stage 4) ---
  if (resourceInput.civitaiResources) {
    for (const r of resourceInput.civitaiResources) {
      if (!r.modelVersionId) continue;
      const existing = resolved.get(r.modelVersionId);
      const strength = r.weight != null ? Math.round(r.weight * 100) : null;
      // civitaiResources are authoritative — override hash-only matches
      if (!existing || (existing.strength == null && strength != null)) {
        resolved.set(r.modelVersionId, { modelVersionId: r.modelVersionId, strength });
      }
    }
  }

  // --- Enrich via getResourceData() ---
  let allResources: GenerationResource[] = [];
  if (resolved.size > 0) {
    const versionIds = [...resolved.keys()];
    allResources = (await getResourceData(versionIds, { user, withPreview: true, sfwOnly })).map(
      (resource) => {
        const candidate = resolved.get(resource.id);
        if (candidate?.strength != null) {
          return { ...resource, strength: candidate.strength / 100 };
        }
        return resource;
      }
    );
  }

  // --- Normalize metadata + map to graph params (same pipeline as getMediaGenerationData) ---
  const initialMeta = metadata as ImageMetaProps;
  const baseModel = getBaseModelFromResources(
    allResources.map((x) => ({ modelType: x.model.type, baseModel: x.baseModel }))
  );
  const engine = initialMeta.engine ?? (baseModel ? getBaseModelEngine(baseModel) : undefined);

  const metaRecord = initialMeta as Record<string, unknown>;
  const { resources, params } = resolveGraphParamsFromImageMeta({
    initialMeta,
    baseModel,
    engine,
    allResources,
    width: (metaRecord.width as number) ?? 0,
    height: (metaRecord.height as number) ?? 0,
  });

  return { resources, params };
}
