import {
  CommercialUse,
  MetricTimeframe,
  ModelModifier,
  ModelStatus,
  ModelType,
  ModelUploadType,
  Prisma,
  TagTarget,
} from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { ManipulateType } from 'dayjs';
import { isEmpty } from 'lodash-es';
import { SessionUser } from 'next-auth';

import { env } from '~/env/server.mjs';
import { BaseModel, BaseModelType, CacheTTL } from '~/server/common/constants';
import { ModelSort, NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { Context } from '~/server/createContext';
import { dbRead, dbWrite } from '~/server/db/client';
import { getDbWithoutLag, preventReplicationLag } from '~/server/db/db-helpers';
import { requestScannerTasks } from '~/server/jobs/scan-files';
import { redis } from '~/server/redis/client';
import { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import {
  GetAllModelsOutput,
  GetModelVersionsSchema,
  ModelGallerySettingsSchema,
  ModelInput,
  ModelMeta,
  ModelUpsertInput,
  PublishModelSchema,
  ToggleCheckpointCoverageInput,
  ToggleModelLockInput,
  UnpublishModelSchema,
} from '~/server/schema/model.schema';
import { isNotTag, isTag } from '~/server/schema/tag.schema';
import { imagesSearchIndex, modelsSearchIndex } from '~/server/search-index';
import { associatedResourceSelect } from '~/server/selectors/model.selector';
import { modelFileSelect } from '~/server/selectors/modelFile.selector';
import { simpleUserSelect, userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  getAvailableCollectionItemsFilterForUser,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';
import {
  getUnavailableResources,
  prepareModelInOrchestrator,
} from '~/server/services/generation/generation.service';
import {
  getImagesForModelVersionCache,
  getImagesForModelVersion,
} from '~/server/services/image.service';
import { getCategoryTags } from '~/server/services/system-cache';
import { getCosmeticsForUsers, getProfilePicturesForUsers } from '~/server/services/user.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { getEarlyAccessDeadline, isEarlyAccess } from '~/server/utils/early-access-helpers';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import {
  DEFAULT_PAGE_SIZE,
  getCursor,
  getPagination,
  getPagingData,
} from '~/server/utils/pagination-helpers';
import { decreaseDate } from '~/utils/date-helpers';
import { prepareFile } from '~/utils/file-helpers';
import { fromJson, toJson } from '~/utils/json-helpers';
import { getS3Client } from '~/utils/s3-utils';
import { isDefined } from '~/utils/type-guards';
import {
  GetAssociatedResourcesInput,
  GetModelsWithCategoriesSchema,
  SetAssociatedResourcesInput,
  SetModelsCategoryInput,
} from './../schema/model.schema';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { getFilesForModelVersionCache } from '~/server/services/model-file.service';
import {
  BadgeCosmetic,
  ContentDecorationCosmetic,
  WithClaimKey,
} from '~/server/selectors/cosmetic.selector';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';

export const getModel = async <TSelect extends Prisma.ModelSelect>({
  id,
  user,
  select,
}: GetByIdInput & {
  user?: SessionUser;
  select: TSelect;
}) => {
  const db = await getDbWithoutLag('model', id);
  const result = await db.model.findFirst({
    where: {
      id,
    },
    select,
  });

  return result;
};

type ModelRaw = {
  id: number;
  name: string;
  description?: string | null;
  type: ModelType;
  poi?: boolean;
  nsfw: boolean;
  nsfwLevel: number;
  allowNoCredit?: boolean;
  allowCommercialUse?: CommercialUse[];
  allowDerivatives?: boolean;
  allowDifferentLicense?: boolean;
  status: string;
  createdAt: Date;
  lastVersionAt: Date;
  publishedAt: Date | null;
  locked: boolean;
  earlyAccessDeadline: Date;
  mode: string;
  rank: {
    downloadCount: number;
    thumbsUpCount: number;
    thumbsDownCount: number;
    commentCount: number;
    ratingCount: number;
    rating: number;
    collectedCount: number;
    tippedAmountCount: number;
  };
  tagsOnModels: {
    tagId: number;
    name: string;
  }[];
  hashes: {
    hash: string;
  }[];
  modelVersions: {
    id: number;
    name: string;
    earlyAccessTimeFrame: number;
    baseModel: BaseModel;
    baseModelType: BaseModelType;
    createdAt: Date;
    trainingStatus: string;
    trainedWords?: string[];
    vaeId: number | null;
    publishedAt: Date | null;
    status: ModelStatus;
    covered: boolean;
  }[];
  user: {
    id: number;
    username: string | null;
    deletedAt: Date | null;
    image: string;
  };
  cosmetic?: WithClaimKey<ContentDecorationCosmetic> | null;
};

export const getModelsRaw = async ({
  input,
  include,
  user: sessionUser,
}: {
  input: Omit<GetAllModelsOutput, 'limit' | 'page'> & {
    take?: number;
    skip?: number;
  };
  include?: Array<'details' | 'cosmetics'>;
  user?: { id: number; isModerator?: boolean; username?: string };
}) => {
  const {
    user,
    take,
    cursor,
    query, // TODO: Support
    followed,
    archived,
    tag,
    tagname,
    username,
    baseModels,
    types,
    sort,
    period,
    periodMode,
    hidden,
    checkpointType,
    status,
    allowNoCredit,
    allowDifferentLicense,
    allowDerivatives,
    allowCommercialUse,
    ids,
    earlyAccess,
    supportsGeneration,
    fromPlatform,
    needsReview,
    collectionId,
    fileFormats,
    clubId,
    modelVersionIds,
    browsingLevel,
  } = input;

  let pending = input.pending;
  const hasDraftModels = status?.includes(ModelStatus.Draft);

  if (hasDraftModels) {
    pending = true;
  }

  const includeDetails = !!include?.includes('details');
  const includeCosmetics = !!include?.includes('cosmetics');
  function ifDetails(sql: TemplateStringsArray) {
    return includeDetails ? Prisma.raw(sql[0]) : Prisma.empty;
  }

  let isPrivate = false;
  const AND: Prisma.Sql[] = [];

  const userId = sessionUser?.id;
  const isModerator = sessionUser?.isModerator ?? false;

  // TODO.clubs: This is temporary until we are fine with displaying club stuff in public feeds.
  // At that point, we should be relying more on unlisted status which is set by the owner.
  const hidePrivateModels = !ids && !clubId && !username && !user && !followed && !collectionId;

  if (query) {
    const lowerQuery = query?.toLowerCase();

    AND.push(
      Prisma.sql`(${Prisma.join(
        [
          Prisma.sql`
        m."name" ILIKE ${`%${query}%`}
      `,
          Prisma.sql`
        EXISTS (
          SELECT 1 FROM "ModelVersion" mvq
          JOIN "ModelFile" mf ON mf."modelVersionId" = mvq."id"
          JOIN "ModelFileHash" mfh ON mfh."fileId" = mf."id"
          WHERE mvq."modelId" = m."id" AND mfh."hash" = ${query}
        )
      `,
          Prisma.sql`
        EXISTS (
          SELECT 1 FROM "ModelVersion" mvq
          WHERE mvq."modelId" = m."id" AND ${lowerQuery} = ANY(mvq."trainedWords")
        )
      `,
        ],
        ' OR '
      )})`
    );
  }

  if (!archived) {
    AND.push(
      Prisma.sql`(m."mode" IS NULL OR m."mode" != ${ModelModifier.Archived}::"ModelModifier")`
    );
  }

  if (needsReview && sessionUser?.isModerator) {
    AND.push(Prisma.sql`
      (
        m."meta"->>'needsReview' = 'true'
        OR
        EXISTS (
          SELECT 1 FROM "ModelVersion" mv
          WHERE mv."modelId" = m."id"
            AND mv."meta"->>'needsReview' = 'true'
        )
      )
    `);

    isPrivate = true;
  }

  if (tagname ?? tag) {
    AND.push(
      Prisma.sql`EXISTS (
          SELECT 1 FROM "TagsOnModels" tom
          JOIN "Tag" t on tom."tagId" = t."id"
          WHERE tom."modelId" = m."id" AND t."name" = ${tagname ?? tag}
        )`
    );
  }

  if (fromPlatform) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "ModelVersion" mv
      WHERE mv."trainingStatus" IS NOT NULL AND mv."modelId" = m."id"
    )`);
  }

  if (username || user) {
    const targetUser = await dbRead.user.findUnique({
      where: { username: (username || user) ?? '' },
      select: { id: true },
    });

    if (!targetUser) throw new Error('User not found');

    AND.push(Prisma.sql`u.id = ${targetUser.id}`);
  }

  if (types?.length) {
    AND.push(Prisma.sql`m.type = ANY(ARRAY[${Prisma.join(types)}]::"ModelType"[])`);
  }

  if (hidden && sessionUser?.id) {
    AND.push(
      Prisma.sql`EXISTS (
          SELECT 1 FROM "ModelEngagement" e
          WHERE e."modelId" = m."id" AND e."userId" = ${sessionUser?.id} AND e."type" = 'Hide'::"ModelEngagementType")
        `
    );
  }

  if (followed && sessionUser?.id) {
    const followedUsers = await dbRead.user.findUnique({
      where: { id: sessionUser.id },
      select: {
        engagingUsers: {
          select: { targetUser: { select: { id: true } } },
          where: { type: 'Follow' },
        },
      },
    });
    const followedUsersIds =
      followedUsers?.engagingUsers?.map(({ targetUser }) => targetUser.id) ?? [];

    if (!followedUsersIds.length) {
      // Return no results.
      AND.push(Prisma.sql`1 = 0`);
    } else {
      AND.push(Prisma.sql`u."id" IN (${Prisma.join(followedUsersIds, ',')})`);
    }

    isPrivate = true;
  }

  if (baseModels?.length) {
    AND.push(
      Prisma.sql`EXISTS (
          SELECT 1 FROM "ModelVersion" mv
          WHERE mv."modelId" = m."id"
            AND mv."baseModel" IN (${Prisma.join(baseModels, ',')})
        )`
    );
  }

  if (period && period !== MetricTimeframe.AllTime && periodMode !== 'stats') {
    AND.push(
      Prisma.sql`(COALESCE(m."lastVersionAt", lmv."createdAt") >= ${decreaseDate(
        new Date(),
        1,
        period.toLowerCase() as ManipulateType
      )})`
    );
  }
  // If the user is not a moderator, only show published models
  if (!sessionUser?.isModerator || !status?.length) {
    AND.push(Prisma.sql`m."status" = ${ModelStatus.Published}::"ModelStatus"`);
  } else if (sessionUser?.isModerator) {
    if (status?.includes(ModelStatus.Unpublished)) status.push(ModelStatus.UnpublishedViolation);
    AND.push(
      Prisma.sql`m."status" IN (${Prisma.raw(
        status.map((s) => `'${s}'::"ModelStatus"`).join(',')
      )})`
    );

    isPrivate = true;
  }

  // Filter by model permissions
  if (allowCommercialUse && allowCommercialUse.length > 0) {
    AND.push(
      Prisma.sql`m."allowCommercialUse" && ARRAY[${Prisma.join(
        allowCommercialUse,
        ','
      )}]::"CommercialUse"[]`
    );
  }

  if (allowDerivatives !== undefined)
    AND.push(Prisma.sql`m."allowDerivatives" = ${allowDerivatives}`);
  if (allowDifferentLicense !== undefined)
    AND.push(Prisma.sql`m."allowDifferentLicense" = ${allowDifferentLicense}`);
  if (allowNoCredit !== undefined) AND.push(Prisma.sql`m."allowNoCredit" = ${allowNoCredit}`);

  if (!!ids?.length) AND.push(Prisma.sql`m."id" IN (${Prisma.join(ids, ',')})`);

  if (!!modelVersionIds?.length) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "ModelVersion" mv
      WHERE mv."id" IN (${Prisma.join(modelVersionIds, ',')}) AND mv."modelId" = m."id"
    )`);
  }

  if (checkpointType && (!types?.length || types?.includes('Checkpoint'))) {
    const TypeOr: Prisma.Sql[] = [
      Prisma.sql`m."checkpointType" = ${checkpointType}::"CheckpointType"`,
    ];

    const otherTypes = (types ?? []).filter((t) => t !== 'Checkpoint');

    if (otherTypes?.length) {
      TypeOr.push(
        Prisma.sql`m."type" IN (${Prisma.raw(
          otherTypes.map((t) => `'${t}'::"ModelType"`).join(',')
        )})`
      );
    } else TypeOr.push(Prisma.sql`m."type" != 'Checkpoint'`);

    AND.push(Prisma.sql`(${Prisma.join(TypeOr, ' OR ')})`);
  }

  if (earlyAccess) {
    AND.push(Prisma.sql`m."earlyAccessDeadline" >= ${new Date()}`);
  }

  if (supportsGeneration) {
    AND.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "GenerationCoverage" gc WHERE gc."modelId" = m."id" AND gc."covered" = true)`
    );
  }

  if (collectionId) {
    const permissions = await getUserCollectionPermissionsById({
      userId: sessionUser?.id,
      id: collectionId,
    });

    if (!permissions.read) {
      return { items: [], isPrivate: true };
    }

    const { rawAND: collectionItemModelsAND }: { rawAND: Prisma.Sql[] } =
      getAvailableCollectionItemsFilterForUser({ permissions, userId: sessionUser?.id });

    AND.push(
      Prisma.sql`EXISTS (
        SELECT 1 FROM "CollectionItem" ci
        WHERE ci."modelId" = m."id"
        AND ci."collectionId" = ${collectionId}
        AND ${Prisma.join(collectionItemModelsAND, ' AND ')})`
    );

    isPrivate = !permissions.publicCollection;
  }

  let orderBy = `m."lastVersionAt" DESC NULLS LAST`;

  if (sort === ModelSort.HighestRated)
    orderBy = `mm."thumbsUpCount" DESC, mm."downloadCount" DESC, mm."modelId"`;
  else if (sort === ModelSort.MostLiked)
    orderBy = `mm."thumbsUpCount" DESC, mm."downloadCount" DESC, mm."modelId"`;
  else if (sort === ModelSort.MostDownloaded)
    orderBy = `mm."downloadCount" DESC, mm."thumbsUpCount" DESC, mm."modelId"`;
  else if (sort === ModelSort.MostDiscussed)
    orderBy = `mm."commentCount" DESC, mm."thumbsUpCount" DESC, mm."modelId"`;
  else if (sort === ModelSort.MostCollected)
    orderBy = `mm."collectedCount" DESC, mm."thumbsUpCount" DESC, mm."modelId"`;
  // else if (sort === ModelSort.MostTipped)
  //   orderBy = `mm."tippedAmountCount" DESC, mm."thumbsUpCount" DESC, mm."modelId"`;
  else if (sort === ModelSort.ImageCount)
    orderBy = `mm."imageCount" DESC, mm."thumbsUpCount" DESC, mm."modelId"`;
  else if (sort === ModelSort.Oldest) orderBy = `m."lastVersionAt" ASC, m."id"`;

  // eslint-disable-next-line prefer-const
  let { where: cursorClause, prop: cursorProp } = getCursor(orderBy, cursor);
  if (cursorClause) AND.push(cursorClause);
  if (orderBy === `m."lastVersionAt" DESC NULLS LAST`)
    orderBy = 'COALESCE(m."lastVersionAt", \'infinity\') DESC';

  if (!!fileFormats?.length) {
    AND.push(Prisma.sql`EXISTS (
      SELECT 1 FROM "ModelFile" mf
      JOIN "ModelVersion" mv ON mf."modelVersionId" = mv."id" AND mv."modelId" = m."id"
      WHERE mf."modelVersionId" = mv."id"
        AND mf."type" = 'Model'
        AND (${Prisma.join(
          fileFormats.map((format) => Prisma.raw(`mf."metadata" @> '{"format": "${format}"}'`)),
          ' OR '
        )})
    )`);
  }

  const modelVersionWhere: Prisma.Sql[] = [];

  if (!sessionUser?.isModerator || !status?.length) {
    modelVersionWhere.push(Prisma.sql`mv."status" = ${ModelStatus.Published}::"ModelStatus"`);
  }

  if (baseModels) {
    modelVersionWhere.push(Prisma.sql`mv."baseModel" IN (${Prisma.join(baseModels, ',')})`);
  }

  if (!!modelVersionIds?.length) {
    modelVersionWhere.push(Prisma.sql`mv."id" IN (${Prisma.join(modelVersionIds, ',')})`);
  }

  if (hidePrivateModels) {
    modelVersionWhere.push(Prisma.sql`mv."availability" = 'Public'::"Availability"`);
  }

  // if (!includeDetails) {
  const browsingLevelQuery = Prisma.sql`(lmv."nsfwLevel" & ${browsingLevel}) != 0`;
  if (pending && (isModerator || userId)) {
    if (isModerator) {
      AND.push(Prisma.sql`(${browsingLevelQuery} OR lmv."nsfwLevel" = 0)`);
    } else if (userId) {
      AND.push(
        Prisma.sql`(${browsingLevelQuery} OR (lmv."nsfwLevel" = 0 AND m."userId" = ${userId}))`
      );
    }
  } else {
    AND.push(browsingLevelQuery);
  }
  // }

  const WITH: Prisma.Sql[] = [];
  if (clubId) {
    WITH.push(Prisma.sql`
      "clubModels" AS (
        SELECT
          mv."modelId" "modelId",
          MAX(mv."id") "modelVersionId"
        FROM "EntityAccess" ea
        JOIN "ModelVersion" mv ON mv."id" = ea."accessToId"
        LEFT JOIN "ClubTier" ct ON ea."accessorType" = 'ClubTier' AND ea."accessorId" = ct."id" AND ct."clubId" = ${clubId}
        WHERE (
            (
             ea."accessorType" = 'Club' AND ea."accessorId" = ${clubId}
            )
            OR (
              ea."accessorType" = 'ClubTier' AND ct."clubId" = ${clubId}
            )
          )
          AND ea."accessToType" = 'ModelVersion'
        GROUP BY mv."modelId"
      )
    `);

    modelVersionWhere.push(Prisma.sql`cm."modelVersionId" = mv."id"`);
  }
  WITH.push(Prisma.sql`"CTE_ModelVersionDetails" AS NOT MATERIALIZED (
    SELECT
      mv."id",
      mv.index,
      mv."modelId",
      mv."name",
      mv."earlyAccessTimeFrame",
      mv."baseModel",
      mv."baseModelType",
      mv."createdAt",
      mv."trainingStatus",
      mv."publishedAt",
      mv."status",
      mv.availability,
      mv."nsfwLevel",
      ${ifDetails`
        mv."description",
        mv."trainedWords",
        mv."vaeId",
      `}
      COALESCE((
        SELECT gc.covered
        FROM "GenerationCoverage" gc
        WHERE gc."modelVersionId" = mv.id
      ), false) AS covered
    FROM "ModelVersion" mv
    WHERE
      ${
        modelVersionWhere.length > 0
          ? Prisma.sql`${Prisma.join(modelVersionWhere, ' AND ')}`
          : Prisma.sql`1 = 1`
      }
  )`);

  const queryWith = WITH.length > 0 ? Prisma.sql`WITH ${Prisma.join(WITH, ', ')}` : Prisma.sql``;

  const modelQuery = Prisma.sql`
    ${queryWith}
    SELECT
      m."id",
      m."name",
      ${ifDetails`
        m."description",
        m."poi",
        m."allowNoCredit",
        m."allowCommercialUse",
        m."allowDerivatives",
        m."allowDifferentLicense",
      `}
      m."type",
      m."nsfw",
      m."nsfwLevel",
      m."status",
      m."createdAt",
      m."lastVersionAt",
      m."publishedAt",
      m."locked",
      m."earlyAccessDeadline",
      m."mode",
      jsonb_build_object(
        'downloadCount', mm."downloadCount",
        'thumbsUpCount', mm."thumbsUpCount",
        'thumbsDownCount', mm."thumbsDownCount",
        'commentCount', mm."commentCount",
        'ratingCount', mm."ratingCount",
        'rating', mm."rating",
        'collectedCount', mm."collectedCount",
        'tippedAmountCount', mm."tippedAmountCount"
      ) as "rank",
      (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'tagId', "tagId",
          'name', t."name"
          )
        ), '[]'::jsonb) FROM "TagsOnModels"
            JOIN "Tag" t ON "tagId" = t."id"
            WHERE "modelId" = m."id"
            AND "tagId" IS NOT NULL
      ) as "tagsOnModels",
      (
        SELECT COALESCE(jsonb_agg(jsonb_build_object('hash', "hash")), '[]'::jsonb) FROM "ModelHash"
            WHERE "modelId" = m."id"
            AND "modelId" IS NOT NULL
            AND "hashType" = 'SHA256'
            AND "fileType" IN ('Model', 'Pruned Model')
        AND "hash" IS NOT NULL
      ) as "hashes",
      ${
        includeDetails
          ? Prisma.sql`(
            SELECT jsonb_agg(data)
              FROM (
                SELECT row_to_json(mvd) as data
                FROM "CTE_ModelVersionDetails" mvd
                WHERE mvd."modelId" = m.id
                ORDER BY index
              ) as t
            ) as "modelVersions",`
          : Prisma.sql`(
            SELECT jsonb_agg(data)
            FROM (SELECT row_to_json(lmv) AS data) as t
            ) as "modelVersions",`
      }
      jsonb_build_object(
        'id', u."id",
        'username', u."username",
        'deletedAt', u."deletedAt",
        'image', u."image"
      ) as "user",
      ${Prisma.raw(cursorProp ? cursorProp : 'null')} as "cursorId"
    FROM "Model" m
    JOIN "ModelMetric" mm ON mm."modelId" = m."id" AND mm."timeframe" = ${period}::"MetricTimeframe"
    JOIN "User" u ON m."userId" = u.id
    ${clubId ? Prisma.sql`JOIN "clubModels" cm ON cm."modelId" = m."id"` : Prisma.sql``}
    CROSS JOIN LATERAL (
        SELECT *
        FROM "CTE_ModelVersionDetails" mv
        WHERE mv."modelId" = m.id
        ORDER BY mv.index ASC
        LIMIT 1
    ) lmv -- LatestModelVersion
    WHERE ${Prisma.join(AND, ' AND ')}
    ORDER BY ${Prisma.raw(orderBy)}
    LIMIT ${(take ?? 100) + 1}
  `;

  const models = await dbRead.$queryRaw<(ModelRaw & { cursorId: string | bigint | null })[]>(
    modelQuery
  );

  const userIds = models.map((m) => m.user.id);
  const profilePictures = await getProfilePicturesForUsers(userIds);
  const userCosmetics = await getCosmeticsForUsers(userIds);
  const cosmetics = includeCosmetics
    ? await getCosmeticsForEntity({ ids: models.map((m) => m.id), entity: 'Model' })
    : {};

  let nextCursor: string | bigint | undefined;
  if (take && models.length > take) {
    const nextItem = models.pop();
    nextCursor = nextItem?.cursorId || undefined;
  }

  return {
    items: models.map(({ rank, modelVersions, cursorId, ...model }) => ({
      ...model,
      rank: {
        [`downloadCount${input.period}`]: rank.downloadCount,
        [`thumbsUpCount${input.period}`]: rank.thumbsUpCount,
        [`thumbsDownCount${input.period}`]: rank.thumbsDownCount,
        [`commentCount${input.period}`]: rank.commentCount,
        [`ratingCount${input.period}`]: rank.ratingCount,
        [`rating${input.period}`]: rank.rating,
        [`collectedCount${input.period}`]: rank.collectedCount,
        [`tippedAmountCount${input.period}`]: rank.tippedAmountCount,
      },
      modelVersions: (modelVersions ?? []).filter(isDefined),
      user: {
        ...model.user,
        profilePicture: profilePictures?.[model.user.id] ?? null,
        cosmetics: userCosmetics[model.user.id] ?? [],
      },
      cosmetic: cosmetics[model.id] ?? null,
    })),
    nextCursor,
    isPrivate,
  };
};

/** @deprecated use getModelsRaw */
export const getModels = async <TSelect extends Prisma.ModelSelect>({
  input,
  select,
  user: sessionUser,
  count = false,
}: {
  input: Omit<GetAllModelsOutput, 'limit' | 'page' | 'cursor'> & {
    take?: number;
    skip?: number;
    cursor?: number;
  };
  select: TSelect;
  user?: SessionUser;
  count?: boolean;
}) => {
  const {
    take,
    skip,
    cursor,
    query,
    tag,
    tagname,
    user,
    username,
    baseModels,
    types,
    sort,
    period,
    periodMode,
    favorites,
    hidden,
    excludedTagIds,
    excludedUserIds,
    excludedModelIds,
    checkpointType,
    status,
    allowNoCredit,
    allowDifferentLicense,
    allowDerivatives,
    allowCommercialUse,
    ids,
    needsReview,
    earlyAccess,
    supportsGeneration,
    followed,
    collectionId,
    fileFormats,
    browsingLevel,
    clubId,
  } = input;

  const canViewNsfw = sessionUser?.showNsfw ?? env.UNAUTHENTICATED_LIST_NSFW;
  const AND: Prisma.Enumerable<Prisma.ModelWhereInput> = [];
  const lowerQuery = query?.toLowerCase();
  let isPrivate = false;

  // If the user is not a moderator, only show published models
  if (!sessionUser?.isModerator || !status?.length) {
    AND.push({ status: ModelStatus.Published });
  } else if (sessionUser?.isModerator) {
    if (status?.includes(ModelStatus.Unpublished)) status.push(ModelStatus.UnpublishedViolation);
    AND.push({ status: { in: status } });
    isPrivate = true;
  }

  // Filter by model permissions
  if (allowCommercialUse && allowCommercialUse.length > 0) {
    AND.push({ allowCommercialUse: { hasSome: allowCommercialUse } });
  }
  if (allowDerivatives !== undefined) AND.push({ allowDerivatives });
  if (allowDifferentLicense !== undefined) AND.push({ allowDifferentLicense });
  if (allowNoCredit !== undefined) AND.push({ allowNoCredit });

  if (query) {
    AND.push({
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        {
          modelVersions: {
            some: {
              files: query
                ? {
                    some: {
                      hashes: { some: { hash: query } },
                    },
                  }
                : undefined,
            },
          },
        },
        {
          modelVersions: {
            some: {
              trainedWords: { has: lowerQuery },
            },
          },
        },
      ],
    });
  }
  if (!!ids?.length) AND.push({ id: { in: ids } });
  if (excludedUserIds && excludedUserIds.length && !username) {
    AND.push({ userId: { notIn: excludedUserIds } });
  }
  if (excludedTagIds && excludedTagIds.length && !username) {
    AND.push({
      tagsOnModels: { none: { tagId: { in: excludedTagIds } } },
    });
  }
  if (excludedModelIds && !hidden && !username) {
    AND.push({ id: { notIn: excludedModelIds } });
  }
  if (checkpointType && (!types?.length || types?.includes('Checkpoint'))) {
    const TypeOr: Prisma.Enumerable<Prisma.ModelWhereInput> = [{ checkpointType }];
    if (types?.length) {
      const otherTypes = types.filter((t) => t !== 'Checkpoint');
      TypeOr.push({ type: { in: otherTypes } });
    } else TypeOr.push({ type: { not: 'Checkpoint' } });
    AND.push({ OR: TypeOr });
  }
  if (needsReview && sessionUser?.isModerator) {
    AND.push({
      OR: [
        { meta: { path: ['needsReview'], equals: true } },
        { modelVersions: { some: { meta: { path: ['needsReview'], equals: true } } } },
      ],
    });
    isPrivate = true;
  }
  if (earlyAccess) {
    AND.push({ earlyAccessDeadline: { gte: new Date() } });
  }

  if (supportsGeneration) {
    AND.push({ generationCoverage: { some: { covered: true } } });
  }

  // Filter only followed users
  if (!!sessionUser && followed) {
    const followedUsers = await dbRead.user.findUnique({
      where: { id: sessionUser.id },
      select: {
        engagingUsers: {
          select: { targetUser: { select: { id: true } } },
          where: { type: 'Follow' },
        },
      },
    });
    const followedUsersIds =
      followedUsers?.engagingUsers?.map(({ targetUser }) => targetUser.id) ?? [];
    AND.push({ userId: { in: followedUsersIds } });
    isPrivate = true;
  }

  if (collectionId) {
    const permissions = await getUserCollectionPermissionsById({
      userId: sessionUser?.id,
      id: collectionId,
    });

    if (!permissions.read) {
      return { items: [], isPrivate: true };
    }

    const {
      AND: collectionItemModelsAND,
    }: { AND: Prisma.Enumerable<Prisma.CollectionItemWhereInput> } =
      getAvailableCollectionItemsFilterForUser({ permissions, userId: sessionUser?.id });

    AND.push({
      collectionItems: {
        some: {
          collectionId,
          AND: collectionItemModelsAND,
        },
      },
    });
    isPrivate = !permissions.publicCollection;
  }

  if (!!fileFormats?.length) {
    AND.push({
      modelVersions: {
        some: {
          files: {
            some: {
              type: 'Model',
              OR: fileFormats.map((format) => ({
                metadata: { path: ['format'], equals: format },
              })),
            },
          },
        },
      },
    });
  }

  // TODO - filter by browsingLevel
  const where: Prisma.ModelWhereInput = {
    tagsOnModels: tagname ?? tag ? { some: { tag: { name: tagname ?? tag } } } : undefined,
    user: username || user ? { username: username ?? user } : undefined,
    type: types?.length ? { in: types } : undefined,
    engagements: favorites
      ? { some: { userId: sessionUser?.id, type: 'Notify' } }
      : hidden
      ? { some: { userId: sessionUser?.id, type: 'Hide' } }
      : undefined,
    AND: AND.length ? AND : undefined,
    modelVersions: { some: { baseModel: baseModels?.length ? { in: baseModels } : undefined } },
    lastVersionAt:
      period !== MetricTimeframe.AllTime && periodMode !== 'stats'
        ? { gte: decreaseDate(new Date(), 1, period.toLowerCase() as ManipulateType) }
        : undefined,
  };
  if (favorites || hidden) isPrivate = true;

  const orderBy: Prisma.ModelOrderByWithRelationInput = {
    lastVersionAt: { sort: 'desc', nulls: 'last' },
  };

  // No more rank view...
  // if (sort === ModelSort.HighestRated) orderBy = { rank: { [`rating${period}Rank`]: 'asc' } };
  // else if (sort === ModelSort.MostLiked)
  //   orderBy = { rank: { [`thumbsUpCount${period}Rank`]: 'asc' } };
  // else if (sort === ModelSort.MostDownloaded)
  //   orderBy = { rank: { [`downloadCount${period}Rank`]: 'asc' } };
  // else if (sort === ModelSort.MostDiscussed)
  //   orderBy = { rank: { [`commentCount${period}Rank`]: 'asc' } };
  // else if (sort === ModelSort.MostCollected)
  //   orderBy = { rank: { [`collectedCount${period}Rank`]: 'asc' } };
  // else if (sort === ModelSort.MostTipped)
  //   orderBy = { rank: { [`tippedAmountCount${period}Rank`]: 'asc' } };
  // else if (sort === ModelSort.ImageCount)
  //   orderBy = { rank: { [`imageCount${period}Rank`]: 'asc' } };

  const items = await dbRead.model.findMany({
    take,
    skip,
    where,
    cursor: cursor ? { id: cursor } : undefined,
    orderBy,
    select,
  });

  if (count) {
    const count = await dbRead.model.count({ where });
    return { items, count };
  }

  return { items, isPrivate };
};

export const rescanModel = async ({ id }: GetByIdInput) => {
  const modelFiles = await dbRead.modelFile.findMany({
    where: { modelVersion: { modelId: id } },
    select: { id: true, url: true },
  });

  const s3 = getS3Client();
  const tasks = modelFiles.map((file) => async () => {
    await requestScannerTasks({
      file,
      s3,
      tasks: ['Hash', 'Scan', 'ParseMetadata'],
      lowPriority: true,
    });
  });

  await limitConcurrency(tasks, 10);
};

export type GetModelsWithImagesAndModelVersions = AsyncReturnType<
  typeof getModelsWithImagesAndModelVersions
>['items'][0];

export const getModelsWithImagesAndModelVersions = async ({
  input,
  user,
}: {
  input: GetAllModelsOutput;
  user?: SessionUser;
}) => {
  input.limit = input.limit ?? 100;

  let modelVersionWhere: Prisma.ModelVersionWhereInput | undefined = {};

  if (!user?.isModerator || !input.status?.length) {
    modelVersionWhere.status = ModelStatus.Published;
  }

  if (input.baseModels) {
    modelVersionWhere.baseModel = { in: input.baseModels };
  }

  if (Object.keys(modelVersionWhere).length === 0) {
    modelVersionWhere = undefined;
  }

  const { items, isPrivate, nextCursor } = await getModelsRaw({
    input: { ...input, take: input.limit },
    user,
    include: ['cosmetics'],
  });

  const modelVersionIds = items
    .filter((model) => model.mode !== ModelModifier.TakenDown)
    .flatMap((m) => m.modelVersions)
    .map((m) => m.id);

  const modelVersionImages = !!modelVersionIds.length
    ? await getImagesForModelVersionCache(modelVersionIds)
    : {};

  const { excludedTagIds, status } = input;
  const includeDrafts = status?.includes(ModelStatus.Draft);

  const unavailableGenResources = await getUnavailableResources();
  const result = {
    nextCursor,
    isPrivate,
    items: items
      .map(({ hashes, modelVersions, rank, tagsOnModels, ...model }) => {
        const [version] = modelVersions;
        if (!version) {
          return null;
        }
        const versionImages = modelVersionImages[version.id]?.images ?? [];
        const filteredImages = excludedTagIds
          ? versionImages.filter((x) => !excludedTagIds?.includes(x.id))
          : versionImages;
        const showImageless =
          (user?.isModerator || model.user.id === user?.id) &&
          (input.user || input.username || includeDrafts);
        if (!filteredImages.length && !showImageless) return null;

        const canGenerate =
          !!version?.covered && unavailableGenResources.indexOf(version.id) === -1;

        return {
          ...model,
          tags: tagsOnModels.map((x) => x.tagId), // not sure why we even use scoring here...
          hashes: hashes.map((hash) => hash.hash.toLowerCase()),
          rank: {
            downloadCount: rank?.[`downloadCount${input.period}`] ?? 0,
            thumbsUpCount: rank?.[`thumbsUpCount${input.period}`] ?? 0,
            thumbsDownCount: rank?.[`thumbsDownCount${input.period}`] ?? 0,
            commentCount: rank?.[`commentCount${input.period}`] ?? 0,
            ratingCount: rank?.[`ratingCount${input.period}`] ?? 0,
            collectedCount: rank?.[`collectedCount${input.period}`] ?? 0,
            tippedAmountCount: rank?.[`tippedAmountCount${input.period}`] ?? 0,
            rating: rank?.[`rating${input.period}`] ?? 0,
          },
          version,
          // // !important - for feed queries, when `model.nsfw === true`, we set all image `nsfwLevel` values to `NsfwLevel.XXX`
          // images: model.nsfw
          //   ? versionImages.map((x) => ({ ...x, nsfwLevel: NsfwLevel.XXX }))
          //   : versionImages,
          images: filteredImages,
          canGenerate,
        };
      })
      .filter(isDefined),
  };

  return result;
};

export const getModelVersionsMicro = async ({
  id,
  excludeUnpublished: excludeDrafts,
}: GetModelVersionsSchema) => {
  const versions = await dbRead.modelVersion.findMany({
    where: {
      modelId: id,
      status: excludeDrafts ? ModelStatus.Published : undefined,
    },
    orderBy: { index: 'asc' },
    select: {
      id: true,
      name: true,
      index: true,
      earlyAccessTimeFrame: true,
      createdAt: true,
      publishedAt: true,
    },
  });

  return versions.map(({ earlyAccessTimeFrame, createdAt, publishedAt, ...v }) => ({
    ...v,
    isEarlyAccess: isEarlyAccess({
      earlyAccessTimeframe: earlyAccessTimeFrame,
      publishedAt,
      versionCreatedAt: createdAt,
    }),
  }));
};

export const updateModelById = ({ id, data }: { id: number; data: Prisma.ModelUpdateInput }) => {
  return dbWrite.model.update({
    where: { id },
    data,
  });
};

export const deleteModelById = async ({
  id,
  userId,
}: GetByIdInput & {
  userId: number;
}) => {
  const deletedModel = await dbWrite.$transaction(async (tx) => {
    const model = await tx.model.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: ModelStatus.Deleted,
        deletedBy: userId,
        modelVersions: {
          updateMany: {
            where: { status: { in: [ModelStatus.Published, ModelStatus.Scheduled] } },
            data: { status: ModelStatus.Deleted },
          },
        },
      },
      select: { id: true, userId: true, nsfwLevel: true, modelVersions: { select: { id: true } } },
    });
    if (!model) return null;

    // TODO - account for case that a user restores a model and doesn't want all posts to be re-published
    const versionIds = model.modelVersions.map(({ id }) => id);
    if (versionIds.length > 0)
      await tx.$executeRaw`
        UPDATE "Post"
        SET "metadata" = "metadata" || jsonb_build_object(
          'unpublishedAt', ${new Date().toISOString()},
          'unpublishedBy', ${userId}
        )
        WHERE "publishedAt" IS NOT NULL
        AND "userId" = ${model.userId}
        AND "modelVersionId" IN (${Prisma.join(
          model.modelVersions.map(({ id }) => id),
          ','
        )})
      `;

    return model;
  });

  await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);

  return deletedModel;
};

export const restoreModelById = ({ id }: GetByIdInput) => {
  return dbWrite.model.update({
    where: { id },
    data: {
      deletedAt: null,
      status: 'Draft',
      deletedBy: null,
      modelVersions: {
        updateMany: { where: { status: 'Deleted' }, data: { status: 'Draft' } },
      },
    },
  });
};

export const permaDeleteModelById = async ({
  id,
}: GetByIdInput & {
  userId: number;
}) => {
  const deletedModel = await dbWrite.$transaction(async (tx) => {
    const model = await tx.model.findUnique({
      where: { id },
      select: { id: true, userId: true, nsfwLevel: true, modelVersions: { select: { id: true } } },
    });
    if (!model) return null;

    await tx.post.deleteMany({
      where: {
        userId: model.userId,
        modelVersionId: { in: model.modelVersions.map(({ id }) => id) },
      },
    });

    const deletedModel = await tx.model.delete({ where: { id } });
    return deletedModel;
  });

  await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);

  return deletedModel;
};

const prepareModelVersions = (versions: ModelInput['modelVersions']) => {
  return versions.map(({ files, ...version }) => {
    // Keep tab whether there's a file format-type conflict.
    // We needed to manually check for this because Prisma doesn't do
    // error handling all too well
    const fileConflicts: Record<string, boolean> = {};

    return {
      ...version,
      files: files.map((file) => {
        const preparedFile = prepareFile(file);
        const {
          type,
          metadata: { format, size },
        } = preparedFile;
        const key = [size, type, format].filter(Boolean).join('-');

        if (fileConflicts[key])
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Only 1 ${key.replace(
              '-',
              ' '
            )} file can be attached to a version, please review your uploads and try again`,
          });
        else fileConflicts[key] = true;

        return preparedFile;
      }),
    };
  });
};

export const upsertModel = async (
  input: ModelUpsertInput & {
    userId: number;
    meta?: Prisma.ModelCreateInput['meta']; // TODO.manuel: hardcoding meta type since it causes type issues in lots of places if we set it in the schema
    isModerator?: boolean;
  }
) => {
  if (!input.isModerator) {
    for (const key of input.lockedProperties ?? []) delete input[key as keyof typeof input];
  }

  const { id, tagsOnModels, userId, templateId, bountyId, meta, isModerator, ...data } = input;

  // don't allow updating of locked properties
  if (!isModerator) {
    const lockedProperties = data.lockedProperties ?? [];
    for (const prop of lockedProperties) {
      const key = prop as keyof typeof data;
      if (data[key] !== undefined) delete data[key];
    }
  }
  if (!id || templateId) {
    const result = await dbWrite.model.create({
      select: { id: true, nsfwLevel: true },
      data: {
        ...data,
        meta:
          bountyId || meta
            ? {
                ...((meta ?? {}) as MixedObject),
                bountyId,
              }
            : undefined,
        userId,
        tagsOnModels: tagsOnModels
          ? {
              create: tagsOnModels.map((tag) => {
                const name = tag.name.toLowerCase().trim();
                return {
                  tag: {
                    connectOrCreate: {
                      where: { name },
                      create: { name, target: [TagTarget.Model] },
                    },
                  },
                };
              }),
            }
          : undefined,
      },
    });
    await preventReplicationLag('model', result.id);
    return result;
  } else {
    const beforeUpdate = await dbRead.model.findUnique({
      where: { id },
      select: { poi: true, userId: true },
    });
    if (!beforeUpdate) return null;

    const isOwner = beforeUpdate.userId === userId || isModerator;
    if (!isOwner) return null;

    const result = await dbWrite.model.update({
      select: { id: true, nsfwLevel: true, poi: true },
      where: { id },
      data: {
        ...data,
        meta,
        tagsOnModels: tagsOnModels
          ? {
              deleteMany: {
                tagId: {
                  notIn: tagsOnModels.filter(isTag).map((x) => x.id),
                },
              },
              connectOrCreate: tagsOnModels.filter(isTag).map((tag) => ({
                where: { modelId_tagId: { tagId: tag.id, modelId: id as number } },
                create: { tagId: tag.id },
              })),
              create: tagsOnModels.filter(isNotTag).map((tag) => {
                const name = tag.name.toLowerCase().trim();
                return {
                  tag: {
                    connectOrCreate: {
                      where: { name },
                      create: { name, target: [TagTarget.Model] },
                    },
                  },
                };
              }),
            }
          : undefined,
      },
    });
    await preventReplicationLag('model', id);

    // Handle POI change
    const poiChanged = beforeUpdate && result.poi !== beforeUpdate.poi;
    // A trigger now handles updating images to reflect the poi setting. We don't need to do it here.

    // Update search index if listing changes
    if (tagsOnModels || poiChanged) {
      await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);
    }

    return result;
  }
};

export const publishModelById = async ({
  id,
  versionIds,
  publishedAt,
  meta,
  republishing,
}: PublishModelSchema & {
  meta?: ModelMeta;
  republishing?: boolean;
}) => {
  const includeVersions = versionIds && versionIds.length > 0;
  let status: ModelStatus = ModelStatus.Published;
  if (publishedAt && publishedAt > new Date()) status = ModelStatus.Scheduled;
  else publishedAt = new Date();

  const model = await dbWrite.$transaction(
    async (tx) => {
      const model = await tx.model.update({
        where: { id },
        data: {
          status,
          publishedAt: !republishing ? publishedAt : undefined,
          meta: isEmpty(meta) ? Prisma.JsonNull : meta,
          modelVersions: includeVersions
            ? {
                updateMany: {
                  where: { id: { in: versionIds } },
                  data: { status, publishedAt: !republishing ? publishedAt : undefined },
                },
              }
            : undefined,
        },
        select: {
          id: true,
          type: true,
          userId: true,
          modelVersions: { select: { id: true, baseModel: true } },
          status: true,
        },
      });

      if (includeVersions) {
        await tx.$executeRaw`
          UPDATE "Post"
          SET
            "metadata" = "metadata" - 'unpublishedAt' - 'unpublishedBy',
            "publishedAt" = ${publishedAt}
          WHERE "userId" = ${model.userId}
          AND "modelVersionId" IN (${Prisma.join(versionIds, ',')})
        `;
      }
      if (!republishing && !meta?.unpublishedBy) await updateModelLastVersionAt({ id, tx });

      return model;
    },
    { timeout: 10000 }
  );

  if (includeVersions && status !== ModelStatus.Scheduled) {
    // Send to orchestrator
    Promise.all(
      model.modelVersions.map((version) => prepareModelInOrchestrator({ id: version.id }))
    );
  }

  // Fetch affected posts to update their images in search index
  const posts = await dbRead.post.findMany({
    where: { modelVersionId: { in: model.modelVersions.map((x) => x.id) }, userId: model.userId },
    select: { id: true },
  });
  const images = await dbRead.image.findMany({
    where: { postId: { in: posts.map((x) => x.id) } },
    select: { id: true },
  });

  // Update search index for model
  await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);
  // Update search index for all affected images
  await imagesSearchIndex.queueUpdate(
    images.map((x) => ({ id: x.id, action: SearchIndexUpdateQueueAction.Update }))
  );

  return model;
};

export const unpublishModelById = async ({
  id,
  reason,
  customMessage,
  meta,
  user,
}: UnpublishModelSchema & {
  meta?: ModelMeta;
  user: SessionUser;
}) => {
  const model = await dbWrite.$transaction(
    async (tx) => {
      const unpublishedAt = new Date().toISOString();
      const updatedMeta = {
        ...meta,
        ...(reason
          ? {
              unpublishedReason: reason,
              customMessage,
            }
          : {}),
        unpublishedAt,
        unpublishedBy: user.id,
      };
      const updatedModel = await tx.model.update({
        where: { id },
        data: {
          status: reason ? ModelStatus.UnpublishedViolation : ModelStatus.Unpublished,
          meta: updatedMeta,
          modelVersions: {
            updateMany: {
              where: { status: { in: [ModelStatus.Published, ModelStatus.Scheduled] } },
              data: { status: ModelStatus.Unpublished, meta: updatedMeta },
            },
          },
        },
        select: { userId: true, modelVersions: { select: { id: true } } },
      });

      const versionIds = updatedModel.modelVersions.map((x) => x.id);
      await tx.$executeRaw`
        UPDATE "Post"
        SET
          "metadata" = "metadata" || jsonb_build_object(
            'unpublishedAt', ${unpublishedAt},
            'unpublishedBy', ${user.id}
          ),
          "publishedAt" = NULL
        WHERE "publishedAt" IS NOT NULL
        AND "userId" = ${updatedModel.userId}
        AND "modelVersionId" IN (${Prisma.join(versionIds)})
      `;

      return updatedModel;
    },
    { timeout: 10000 }
  );

  // Fetch affected posts to remove their images from search index
  const posts = await dbRead.post.findMany({
    where: { modelVersionId: { in: model.modelVersions.map((x) => x.id) }, userId: model.userId },
    select: { id: true },
  });
  const images = await dbRead.image.findMany({
    where: { postId: { in: posts.map((x) => x.id) } },
    select: { id: true },
  });

  // Remove this model from search index as it's been unpublished.
  await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
  // Remove all affected images from search index
  await imagesSearchIndex.queueUpdate(
    images.map((x) => ({ id: x.id, action: SearchIndexUpdateQueueAction.Delete }))
  );

  return model;
};

export const getVaeFiles = async ({ vaeIds }: { vaeIds: number[] }) => {
  const files = (
    await dbRead.modelFile.findMany({
      where: {
        modelVersionId: { in: vaeIds },
        type: 'Model',
      },
      select: { ...modelFileSelect, modelVersionId: true },
    })
  ).map((x) => {
    x.type = 'VAE';
    return x;
  });

  return files;
};

export const getDraftModelsByUserId = async <TSelect extends Prisma.ModelSelect>({
  userId,
  select,
  page,
  limit = DEFAULT_PAGE_SIZE,
}: GetAllSchema & {
  userId: number;
  select: TSelect;
}) => {
  const { take, skip } = getPagination(limit, page);
  const where: Prisma.ModelFindManyArgs['where'] = {
    userId,
    status: { notIn: [ModelStatus.Published, ModelStatus.Deleted] },
    uploadType: { equals: ModelUploadType.Created },
  };

  const items = await dbRead.model.findMany({
    select,
    skip,
    take,
    where,
    orderBy: { updatedAt: 'desc' },
  });
  const count = await dbRead.model.count({ where });

  return getPagingData({ items, count }, take, page);
};

export const getTrainingModelsByUserId = async <TSelect extends Prisma.ModelSelect>({
  userId,
  select,
  page,
  limit = DEFAULT_PAGE_SIZE,
}: GetAllSchema & {
  userId: number;
  select: TSelect;
}) => {
  const { take, skip } = getPagination(limit, page);
  const where: Prisma.ModelFindManyArgs['where'] = {
    userId,
    status: { notIn: [ModelStatus.Published, ModelStatus.Deleted] },
    uploadType: { equals: ModelUploadType.Trained },
  };

  const items = await dbRead.model.findMany({
    select,
    skip,
    take,
    where,
    orderBy: { updatedAt: 'desc' },
  });
  const count = await dbRead.model.count({ where });

  return getPagingData({ items, count }, take, page);
};

export const toggleLockModel = async ({ id, locked }: ToggleModelLockInput) => {
  await dbWrite.model.update({ where: { id }, data: { locked } });
};

export const getSimpleModelWithVersions = async ({
  id,
  ctx,
}: GetByIdInput & {
  ctx?: Context;
}) => {
  const model = await getModel({
    id,
    user: ctx?.user,
    select: {
      id: true,
      name: true,
      createdAt: true,
      locked: true,
      status: true,
      user: { select: userWithCosmeticsSelect },
    },
  });
  if (!model) throw throwNotFoundError();
  return model;
};

export const updateModelEarlyAccessDeadline = async ({ id }: GetByIdInput) => {
  const model = await dbRead.model.findUnique({
    where: { id },
    select: {
      id: true,
      publishedAt: true,
      modelVersions: {
        where: { status: ModelStatus.Published },
        select: { id: true, earlyAccessTimeFrame: true, createdAt: true },
      },
    },
  });
  if (!model) throw throwNotFoundError();

  const { modelVersions } = model;
  const nextEarlyAccess = modelVersions.find(
    (v) =>
      v.earlyAccessTimeFrame > 0 &&
      isEarlyAccess({
        earlyAccessTimeframe: v.earlyAccessTimeFrame,
        versionCreatedAt: v.createdAt,
        publishedAt: model.publishedAt,
      })
  );

  if (nextEarlyAccess) {
    await updateModelById({
      id,
      data: {
        earlyAccessDeadline: getEarlyAccessDeadline({
          earlyAccessTimeframe: nextEarlyAccess.earlyAccessTimeFrame,
          versionCreatedAt: nextEarlyAccess.createdAt,
          publishedAt: model.publishedAt,
        }),
      },
    });
  } else {
    await updateModelById({ id, data: { earlyAccessDeadline: null } });
  }
};

export async function updateModelLastVersionAt({
  id,
  tx,
}: {
  id: number;
  tx?: Prisma.TransactionClient;
}) {
  const dbClient = tx ?? dbWrite;

  const modelVersion = await dbClient.modelVersion.findFirst({
    where: { modelId: id, status: ModelStatus.Published, publishedAt: { not: null } },
    select: { publishedAt: true },
    orderBy: { publishedAt: 'desc' },
  });
  if (!modelVersion) return;

  return dbClient.model.update({
    where: { id },
    data: { lastVersionAt: modelVersion.publishedAt },
  });
}

export const getAllModelsWithCategories = async ({
  userId,
  limit,
  page,
}: GetModelsWithCategoriesSchema) => {
  const { take, skip } = getPagination(limit, page);
  const where: Prisma.ModelFindManyArgs['where'] = {
    status: { in: [ModelStatus.Published, ModelStatus.Draft, ModelStatus.Training] },
    deletedAt: null,
    userId,
  };

  const modelCategories = await getCategoryTags('model');
  const categoryIds = modelCategories.map((c) => c.id);

  try {
    const [models, count] = await dbRead.$transaction([
      dbRead.model.findMany({
        take,
        skip,
        where,
        select: {
          id: true,
          name: true,
          tagsOnModels: {
            where: { tagId: { in: categoryIds } },
            select: {
              tag: {
                select: { id: true, name: true },
              },
            },
          },
        },
        orderBy: { name: 'asc' },
      }),
      dbRead.model.count({ where }),
    ]);
    const items = models.map(({ tagsOnModels, ...model }) => ({
      ...model,
      tags: tagsOnModels.map(({ tag }) => tag),
    }));

    return getPagingData({ items, count }, take, page);
  } catch (error) {
    throw throwDbError(error);
  }
};

export const setModelsCategory = async ({
  categoryId,
  modelIds,
  userId,
}: SetModelsCategoryInput & {
  userId: number;
}) => {
  try {
    const modelCategories = await getCategoryTags('model');
    const category = modelCategories.find((c) => c.id === categoryId);
    if (!category) throw throwNotFoundError(`No category with id ${categoryId}`);

    const models = Prisma.join(modelIds);
    const allCategories = Prisma.join(modelCategories.map((c) => c.id));

    // Remove all categories from models
    await dbWrite.$executeRaw`
      DELETE FROM "TagsOnModels" tom
      USING "Model" m
      WHERE m.id = tom."modelId"
        AND m."userId" = ${userId}
        AND "modelId" IN (${models})
        AND "tagId" IN (${allCategories})
    `;

    // Add category to models
    await dbWrite.$executeRaw`
      INSERT INTO "TagsOnModels" ("modelId", "tagId")
      SELECT m.id, ${categoryId}
      FROM "Model" m
      WHERE m."userId" = ${userId}
        AND m.id IN (${models})
      ON CONFLICT ("modelId", "tagId") DO NOTHING;
    `;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

// #region [associated models]
export const getAssociatedResourcesSimple = async ({
  fromId,
  type,
}: GetAssociatedResourcesInput) => {
  const associations = await dbWrite.modelAssociations.findMany({
    where: { fromModelId: fromId, type },
    orderBy: { index: 'asc' },
    select: {
      id: true,
      toModel: {
        select: associatedResourceSelect,
      },
      toArticle: {
        select: { id: true, title: true, nsfwLevel: true, user: { select: simpleUserSelect } },
      },
    },
  });

  const items = associations
    .map(({ id, toModel, toArticle }) =>
      toModel
        ? { id, item: toModel, resourceType: 'model' as const }
        : toArticle
        ? { id, item: toArticle, resourceType: 'article' as const }
        : null
    )
    .filter(isDefined);

  return items;
};

export const setAssociatedResources = async (
  { fromId, type, associations }: SetAssociatedResourcesInput,
  user?: SessionUser
) => {
  const fromModel = await dbWrite.model.findUnique({
    where: { id: fromId },
    select: {
      userId: true,
      associations: {
        where: { type },
        select: { id: true },
        orderBy: { index: 'asc' },
      },
    },
  });

  if (!fromModel) throw throwNotFoundError();
  // only allow moderators or model owners to add/remove associated models
  if (!user?.isModerator && fromModel.userId !== user?.id) throw throwAuthorizationError();

  const existingAssociations = fromModel.associations.map((x) => x.id);
  const associationsToRemove = existingAssociations.filter(
    (existingToId) => !associations.find((item) => item.id === existingToId)
  );

  return await dbWrite.$transaction([
    // remove associated resources not included in payload
    dbWrite.modelAssociations.deleteMany({
      where: {
        fromModelId: fromId,
        type,
        id: { in: associationsToRemove },
      },
    }),
    // add or update associated models
    ...associations.map((association, index) => {
      const data =
        association.resourceType === 'model'
          ? { fromModelId: fromId, toModelId: association.resourceId, type }
          : { fromModelId: fromId, toArticleId: association.resourceId, type };

      return dbWrite.modelAssociations.upsert({
        where: { id: association.id ?? -1 },
        update: { index },
        create: { ...data, associatedById: user?.id, index },
      });
    }),
  ]);
};
// #endregion

export const getGallerySettingsByModelId = async ({ id }: GetByIdInput) => {
  const cachedSettings = await redis.get(`model:gallery-settings:${id}`);
  if (cachedSettings)
    return fromJson<ReturnType<typeof getGalleryHiddenPreferences>>(cachedSettings);

  const model = await getModel({
    id: id,
    select: { id: true, userId: true, gallerySettings: true },
  });
  if (!model) return null;

  const settings = model.gallerySettings
    ? await getGalleryHiddenPreferences({
        settings: model.gallerySettings as ModelGallerySettingsSchema,
      })
    : null;
  await redis.set(`model:gallery-settings:${id}`, toJson(settings), { EX: CacheTTL.week });

  return settings;
};

export const getGalleryHiddenPreferences = async ({
  settings,
}: {
  settings: ModelGallerySettingsSchema;
}) => {
  const { tags, users, images, level, pinnedPosts } = settings;
  const hiddenTags =
    tags && tags.length
      ? await dbRead.tag.findMany({
          where: { id: { in: tags } },
          select: { id: true, name: true },
        })
      : [];

  const hiddenUsers =
    users && users.length
      ? await dbRead.user.findMany({
          where: { id: { in: users } },
          select: { id: true, username: true },
        })
      : [];

  return {
    hiddenTags,
    hiddenUsers,
    hiddenImages: images ?? [],
    level: level ?? allBrowsingLevelsFlag,
    pinnedPosts: pinnedPosts ?? {},
  };
};

export async function getCheckpointGenerationCoverage(versionIds: number[]) {
  if (versionIds.length === 0) {
    return [];
  }

  const coveredResources = await dbRead.$queryRaw<{ version_id: number }[]>`
    SELECT version_id FROM "CoveredCheckpointDetails"
    WHERE version_id IN (${Prisma.join(versionIds)});
  `;

  return coveredResources.map((x) => x.version_id);
}

export async function toggleCheckpointCoverage({ id, versionId }: ToggleCheckpointCoverageInput) {
  const affectedVersionIds = await dbWrite.$queryRaw<{ version_id: number }[]>`
    SELECT version_id FROM "CoveredCheckpointDetails"
    JOIN "ModelVersion" mv ON mv.id = version_id
    WHERE mv."modelId" = ${id};
  `;

  const transaction: Prisma.PrismaPromise<unknown>[] = [
    dbWrite.$executeRaw`
      REFRESH MATERIALIZED VIEW "CoveredCheckpointDetails";
    `,
  ];

  if (versionId) {
    if (affectedVersionIds.some((x) => x.version_id === versionId)) {
      transaction.unshift(
        dbWrite.$executeRaw`
        DELETE FROM "CoveredCheckpoint"
        WHERE ("model_id" = ${id} AND "version_id" = ${versionId}) OR ("model_id" = ${id} AND "version_id" IS NULL);
      `
      );
      affectedVersionIds.splice(
        affectedVersionIds.findIndex((x) => x.version_id === versionId),
        1
      );
    } else {
      transaction.unshift(
        dbWrite.$executeRaw`
        INSERT INTO "CoveredCheckpoint" ("model_id", "version_id")
        VALUES (${id}, ${versionId})
        ON CONFLICT DO NOTHING;
      `
      );
      affectedVersionIds.push({ version_id: versionId });
    }
  }

  await dbWrite.$transaction(transaction);

  return affectedVersionIds.map((x) => x.version_id);
}

export async function getModelsWithVersions({
  input,
  user,
}: {
  input: GetAllModelsOutput & { take?: number; skip?: number };
  user?: {
    id: number;
    isModerator?: boolean;
    username?: string;
    filePreferences?: UserFilePreferences;
  };
}) {
  const { items, nextCursor } = await getModelsRaw({
    input,
    user,
    include: ['details'],
  });

  const modelVersionIds = items.flatMap(({ modelVersions }) => modelVersions.map(({ id }) => id));
  // Let's swap to the new cache based method for now...
  const images = await getImagesForModelVersionCache(modelVersionIds);
  // const images = await getImagesForModelVersion({
  //   modelVersionIds,
  //   imagesPerVersion: 10,
  //   include: [],
  //   excludedTagIds: input.excludedImageTagIds,
  //   excludedIds: await getHiddenImagesForUser({ userId: user?.id }),
  //   excludedUserIds: input.excludedUserIds,
  //   currentUserId: user?.id,
  // });

  const vaeIds = items
    .flatMap(({ modelVersions }) => modelVersions.map(({ vaeId }) => vaeId))
    .filter(isDefined);
  const vaeFiles = await getVaeFiles({ vaeIds });

  const groupedFiles = await getFilesForModelVersionCache(modelVersionIds);

  const modelIds = items.map(({ id }) => id);
  const metrics = await dbRead.modelMetric.findMany({
    where: { modelId: { in: modelIds }, timeframe: MetricTimeframe.AllTime },
  });

  const versionMetrics = await dbRead.modelVersionMetric.findMany({
    where: { modelVersionId: { in: modelVersionIds }, timeframe: MetricTimeframe.AllTime },
  });

  function getStatsForModel(modelId: number) {
    const stats = metrics.find((x) => x.modelId === modelId);
    return {
      downloadCount: stats?.downloadCount ?? 0,
      favoriteCount: 0,
      thumbsUpCount: stats?.thumbsUpCount ?? 0,
      thumbsDownCount: stats?.thumbsDownCount ?? 0,
      commentCount: stats?.commentCount ?? 0,
      ratingCount: 0,
      rating: 0,
      tippedAmountCount: stats?.tippedAmountCount ?? 0,
    };
  }

  function getStatsForVersion(versionId: number) {
    const stats = versionMetrics.find((x) => x.modelVersionId === versionId);
    return {
      downloadCount: stats?.downloadCount ?? 0,
      ratingCount: stats?.ratingCount ?? 0,
      rating: Number(stats?.rating?.toFixed(2) ?? 0),
      thumbsUpCount: stats?.thumbsUpCount ?? 0,
      thumbsDownCount: stats?.thumbsDownCount ?? 0,
    };
  }

  return {
    items: items.map(
      ({
        modelVersions,
        rank,
        hashes,
        earlyAccessDeadline,
        status,
        locked,
        publishedAt,
        createdAt,
        lastVersionAt,
        user,
        ...model
      }) => ({
        ...model,
        user: user.username === 'civitai' ? undefined : user,
        modelVersions: modelVersions.map(
          ({ trainingStatus, vaeId, earlyAccessTimeFrame, covered, ...version }) => {
            const stats = getStatsForVersion(version.id);
            const vaeFile = vaeFiles.filter((x) => x.modelVersionId === vaeId);
            const files = groupedFiles[version.id]?.files ?? [];
            files.push(...vaeFile);

            let earlyAccessDeadline = getEarlyAccessDeadline({
              versionCreatedAt: version.createdAt,
              publishedAt: version.publishedAt,
              earlyAccessTimeframe: earlyAccessTimeFrame,
            });
            if (earlyAccessDeadline && new Date() > earlyAccessDeadline)
              earlyAccessDeadline = undefined;

            return {
              ...version,
              files: files.map(({ metadata: metadataRaw, modelVersionId, ...file }) => {
                const metadata = metadataRaw as FileMetadata | undefined;

                return {
                  ...file,
                  metadata: {
                    format: metadata?.format,
                    size: metadata?.size,
                    fp: metadata?.fp,
                  },
                };
              }),
              earlyAccessDeadline,
              stats,
              // images: images
              //   .filter((image) => image.modelVersionId === version.id)
              //   .map(
              //     ({ modelVersionId, name, userId, sizeKB, availability, metadata, ...image }) => ({
              //       ...image,
              //     })
              //   ),
              images: (images[version.id]?.images ?? []).map(
                ({
                  modelVersionId,
                  name,
                  userId,
                  sizeKB,
                  availability,
                  metadata,
                  tags,
                  ...image
                }) => ({
                  ...image,
                })
              ),
            };
          }
        ),
        stats: getStatsForModel(model.id),
      })
    ),
    nextCursor,
  };
}
