import {
  CommercialUse,
  CosmeticSource,
  CosmeticType,
  MetricTimeframe,
  ModelHashType,
  ModelModifier,
  ModelStatus,
  ModelType,
  ModelUploadType,
  Prisma,
  SearchIndexUpdateQueueAction,
  TagTarget,
} from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { ManipulateType } from 'dayjs';
import { isEmpty } from 'lodash-es';
import { SessionUser } from 'next-auth';

import { env } from '~/env/server.mjs';
import { BaseModel, BaseModelType, ModelFileType } from '~/server/common/constants';
import { BrowsingMode, ModelSort } from '~/server/common/enums';
import { Context } from '~/server/createContext';
import { dbRead, dbWrite } from '~/server/db/client';
import { requestScannerTasks } from '~/server/jobs/scan-files';
import { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import {
  GetAllModelsOutput,
  GetModelsByCategoryInput,
  GetModelVersionsSchema,
  ModelGallerySettingsSchema,
  ModelInput,
  ModelMeta,
  ModelUpsertInput,
  PublishModelSchema,
  ToggleModelLockInput,
  UnpublishModelSchema,
} from '~/server/schema/model.schema';
import { isNotTag, isTag } from '~/server/schema/tag.schema';
import { modelsSearchIndex } from '~/server/search-index';
import { associatedResourceSelect } from '~/server/selectors/model.selector';
import { modelFileSelect } from '~/server/selectors/modelFile.selector';
import { modelHashSelect } from '~/server/selectors/modelHash.selector';
import { simpleUserSelect, userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  getAvailableCollectionItemsFilterForUser,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';
import { getImagesForModelVersion } from '~/server/services/image.service';
import { getCategoryTags } from '~/server/services/system-cache';
import { getTypeCategories } from '~/server/services/tag.service';
import { getHiddenImagesForUser } from '~/server/services/user-cache.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { getEarlyAccessDeadline, isEarlyAccess } from '~/server/utils/early-access-helpers';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { DEFAULT_PAGE_SIZE, getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { decreaseDate } from '~/utils/date-helpers';
import { prepareFile } from '~/utils/file-helpers';
import { getS3Client } from '~/utils/s3-utils';
import { isDefined } from '~/utils/type-guards';
import {
  GetAssociatedResourcesInput,
  GetModelsWithCategoriesSchema,
  SetAssociatedResourcesInput,
  SetModelsCategoryInput,
} from './../schema/model.schema';
import { prepareModelInOrchestrator } from '~/server/services/generation/generation.service';
import { entityRequiresClub } from '~/server/services/common.service';
import { profileImageSelect } from '~/server/selectors/image.selector';

export const getModel = <TSelect extends Prisma.ModelSelect>({
  id,
  user,
  select,
}: GetByIdInput & {
  user?: SessionUser;
  select: TSelect;
}) => {
  const OR: Prisma.Enumerable<Prisma.ModelWhereInput> = [{ status: ModelStatus.Published }];
  // if (user?.id) OR.push({ userId: user.id, deletedAt: null });

  return dbRead.model.findFirst({
    where: {
      id,
      // OR: !user?.isModerator ? OR : undefined,
    },
    select,
  });
};

type ModelRaw = {
  id: number;
  name: string;
  type: ModelType;
  nsfw: boolean;
  status: string;
  createdAt: Date;
  lastVersionAt: Date;
  publishedAt: Date | null;
  locked: boolean;
  earlyAccessDeadline: Date;
  mode: string;
  rank: {
    downloadCount: number;
    favoriteCount: number;
    commentCount: number;
    ratingCount: number;
    rating: number;
    collectedCount: number;
    tippedAmountCount: number;
  };
  tagsOnModels: {
    tagId: number;
  }[];
  hashes: {
    hash: string;
  }[];
  modelVersion: {
    id: number;
    earlyAccessTimeFrame: number;
    baseModel: BaseModel;
    baseModelType: BaseModelType;
    createdAt: Date;
    trainingStatus: string;
    generationCoverage: {
      covered: boolean;
    };
  };
  user: {
    id: number;
    username: string | null;
    deletedAt: Date | null;
    image: string;
    profilePictureId?: number | null;
  };
  userCosmetics: {
    data: Prisma.JsonValue;
    cosmetic: {
      data: Prisma.JsonValue;
      type: CosmeticType;
      id: number;
      name: string;
      source: CosmeticSource;
    };
  }[];
};

export const getModelsRaw = async ({
  input,
  user: sessionUser,
  count,
  ignoreListedStatus,
}: {
  input: Omit<GetAllModelsOutput, 'limit' | 'page'> & {
    take?: number;
    skip?: number;
  };
  // TODO: Likely we wanna remove session user all in all.
  user?: { id: number; isModerator?: boolean; username?: string };
  count?: boolean;
  ignoreListedStatus?: boolean;
}) => {
  const {
    user,
    take,
    cursor,
    query, // TODO: Support
    followed,
    tag,
    tagname,
    username,
    baseModels,
    types,
    sort,
    period,
    periodMode,
    rating,
    favorites,
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
    needsReview,
    collectionId,
    fileFormats,
    clubId,
    modelVersionIds,
  } = input;

  let isPrivate = false;
  const AND: Prisma.Sql[] = [];
  const WITH: Prisma.Sql[] = [];

  if (query) {
    const lowerQuery = query?.toLowerCase();

    AND.push(
      Prisma.join(
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
      )
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

  if (username || user) {
    const targetUser = await dbRead.user.findUnique({
      where: { username: (username || user) ?? '' },
      select: { id: true },
    });

    if (!targetUser) throw new Error('User not found');

    AND.push(Prisma.sql`u.id = ${targetUser.id}`);
  }

  if (types?.length) {
    AND.push(
      Prisma.sql`m.type IN (${Prisma.raw(types.map((t) => `'${t}'::"ModelType"`).join(','))})`
    );
  }

  if (rating) {
    AND.push(Prisma.sql`(mr."ratingAllTime" >= ${rating} AND mr."ratingAllTime" < ${rating + 1})`);
  }

  if (favorites && sessionUser?.id) {
    AND.push(
      Prisma.sql`EXISTS (
          SELECT 1 FROM "ModelEngagement" e
          WHERE e."modelId" = m."id" AND e."userId" = ${sessionUser?.id} AND e."type" = 'Favorite'::"ModelEngagementType")
        `
    );
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
      Prisma.sql`(m."lastVersionAt" >= ${decreaseDate(
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
  if (allowCommercialUse !== undefined) {
    const commercialUseOr: CommercialUse[] = [];
    switch (allowCommercialUse) {
      case CommercialUse.None:
        commercialUseOr.push(CommercialUse.None);
        break;
      case CommercialUse.Image:
        commercialUseOr.push(CommercialUse.Image);
      case CommercialUse.RentCivit:
        commercialUseOr.push(CommercialUse.RentCivit);
      case CommercialUse.Rent:
        commercialUseOr.push(CommercialUse.Rent);
      case CommercialUse.Sell:
        commercialUseOr.push(CommercialUse.Sell);
    }

    AND.push(Prisma.sql`m."allowCommercialUse" IN (${Prisma.join(commercialUseOr, ',')})`);
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

  if (sort === ModelSort.HighestRated) orderBy = `mr."rating${period}Rank" ASC`;
  else if (sort === ModelSort.MostLiked) orderBy = `mr."favoriteCount${period}Rank" ASC`;
  else if (sort === ModelSort.MostDownloaded) orderBy = `mr."downloadCount${period}Rank" ASC`;
  else if (sort === ModelSort.MostDiscussed) orderBy = `mr."commentCount${period}Rank" ASC`;
  else if (sort === ModelSort.MostCollected) orderBy = `mr."collectedCount${period}Rank" ASC`;
  else if (sort === ModelSort.MostTipped) orderBy = `mr."tippedAmountCount${period}Rank" ASC`;
  else if (sort === ModelSort.ImageCount) orderBy = `mr."imageCount${period}Rank" ASC`;

  // eslint-disable-next-line prefer-const
  let [cursorProp, cursorDirection] = orderBy?.split(' ');

  if (cursorProp === 'm."lastVersionAt"') {
    // treats a date as a number of seconds since epoch
    cursorProp = `extract(epoch from ${cursorProp})`;
  }

  if (cursor) {
    const cursorOperator = cursorDirection === 'DESC' ? '<' : '>';
    AND.push(Prisma.sql`${Prisma.raw(cursorProp)} ${Prisma.raw(cursorOperator)} ${cursor}`);
  }

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

  if (!ignoreListedStatus) {
    AND.push(
      Prisma.sql`
      (
          m."unlisted" = false
          ${Prisma.raw(sessionUser?.id ? `OR m."userId" = ${sessionUser?.id}` : '')}
      )
      `
    );
  }

  if (clubId) {
    WITH.push(Prisma.sql`
      "clubModels" AS (
        SELECT DISTINCT ON (mv."modelId") "modelId"
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
      )
    `);
  }

  const queryWith = WITH.length > 0 ? Prisma.sql`WITH ${Prisma.join(WITH, ', ')}` : Prisma.sql``;
  const queryFrom = Prisma.sql`
    FROM "Model" m
    LEFT JOIN "ModelRank" mr ON mr."modelId" = m."id"
    LEFT JOIN "User" u ON m."userId" = u.id
    ${clubId ? Prisma.sql`JOIN "clubModels" cm ON cm."modelId" = m."id"` : Prisma.sql``}
    WHERE ${Prisma.join(AND, ' AND ')}
  `;

  let modelVersionWhere: Prisma.Sql | undefined;

  if (!sessionUser?.isModerator || !status?.length) {
    modelVersionWhere = Prisma.sql`mv."status" = ${ModelStatus.Published}::"ModelStatus"`;
  }

  if (baseModels) {
    modelVersionWhere = Prisma.sql`mv."baseModel" IN (${Prisma.join(baseModels, ',')})`;
  }

  if (!!modelVersionIds?.length) {
    modelVersionWhere = Prisma.sql`mv."id" IN (${Prisma.join(modelVersionIds, ',')})`;
  }

  const models = await dbRead.$queryRaw<(ModelRaw & { cursorId: string | bigint | null })[]>`
    ${queryWith}
    SELECT
      m."id",
      m."name",
      m."type",
      m."nsfw",
      m."status",
      m."createdAt",
      m."lastVersionAt",
      m."publishedAt",
      m."locked",
      m."earlyAccessDeadline",
      m."mode",
      ${Prisma.raw(`
        jsonb_build_object(
          'downloadCount', mr."downloadCount${input.period}",
          'favoriteCount', mr."favoriteCount${input.period}",
          'commentCount', mr."commentCount${input.period}",
          'ratingCount', mr."ratingCount${input.period}",
          'rating', mr."rating${input.period}",
          'collectedCount', mr."collectedCount${input.period}",
          'tippedAmountCount', mr."tippedAmountCount${input.period}"
        ) as "rank",
      `)}
      (
        SELECT COALESCE(jsonb_agg(jsonb_build_object('tagId', "tagId")), '[]'::jsonb) FROM "TagsOnModels"
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
      (
        SELECT
         jsonb_build_object(
           'id', mv."id",
           'earlyAccessTimeFrame', mv."earlyAccessTimeFrame",
           'baseModel', mv."baseModel",
           'baseModelType', mv."baseModelType",
           'createdAt', mv."createdAt",
           'trainingStatus', mv."trainingStatus",
           'generationCoverage', jsonb_build_object(
             'covered', COALESCE(gc."covered", false)
            )
         ) as "modelVersion"
       FROM "ModelVersion" mv
	     LEFT JOIN "GenerationCoverage" gc ON gc."modelVersionId" = mv."id"
	     WHERE mv."modelId" = m."id"
         ${modelVersionWhere ? Prisma.sql`AND ${modelVersionWhere}` : Prisma.sql``}
		   ORDER BY mv."index" ASC LIMIT 1
      ) as "modelVersion",
	    jsonb_build_object(
        'id', u."id",
        'username', u."username",
        'deletedAt', u."deletedAt",
        'image', u."image",
        'profilePictureId', u."profilePictureId"
      ) as "user",
      (
        SELECT
          jsonb_agg(
            jsonb_build_object(
              'data', uc.data,
              'cosmetic', jsonb_build_object(
                'id', c.id,
                'data', c.data,
                'type', c.type,
                'source', c.source,
                'name', c.name,
                'leaderboardId', c."leaderboardId",
                'leaderboardPosition', c."leaderboardPosition"
              )
            )
          )
        FROM "UserCosmetic" uc
        JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
            AND "equippedAt" IS NOT NULL
        WHERE uc."userId" = m."userId"
        GROUP BY uc."userId"
      ) as "userCosmetics",
      ${Prisma.raw(cursorProp ? cursorProp : 'null')} as "cursorId"
    ${queryFrom}
    ORDER BY ${Prisma.raw(orderBy)}
    LIMIT ${(take ?? 100) + 1}
  `;

  const profilePictures = await dbRead.image.findMany({
    where: { id: { in: models.map((m) => m.user.profilePictureId).filter(isDefined) } },
    select: { ...profileImageSelect, ingestion: true },
  });

  let nextCursor: string | bigint | undefined;
  if (take && models.length > take) {
    const nextItem = models.pop();
    nextCursor = nextItem?.cursorId || undefined;
  }

  return {
    items: models.map(({ userCosmetics, rank, modelVersion, cursorId, ...model }) => ({
      ...model,
      rank: {
        [`downloadCount${input.period}`]: rank.downloadCount,
        [`favoriteCount${input.period}`]: rank.favoriteCount,
        [`commentCount${input.period}`]: rank.commentCount,
        [`ratingCount${input.period}`]: rank.ratingCount,
        [`rating${input.period}`]: rank.rating,
        [`collectedCount${input.period}`]: rank.collectedCount,
        [`tippedAmountCount${input.period}`]: rank.tippedAmountCount,
      },
      modelVersions: [modelVersion].filter(isDefined),
      user: {
        ...model.user,
        profilePicture: profilePictures.find((p) => p.id === model.user.profilePictureId),
        cosmetics: userCosmetics,
      },
    })),
    nextCursor,
    isPrivate,
  };
};

export const getModels = async <TSelect extends Prisma.ModelSelect>({
  input,
  select,
  user: sessionUser,
  count = false,
  ignoreListedStatus,
}: {
  input: Omit<GetAllModelsOutput, 'limit' | 'page'> & {
    take?: number;
    skip?: number;
  };
  select: TSelect;
  user?: SessionUser;
  count?: boolean;
  ignoreListedStatus?: boolean;
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
    rating,
    favorites,
    hidden,
    excludedTagIds,
    excludedUserIds,
    excludedIds,
    checkpointType,
    status,
    allowNoCredit,
    allowDifferentLicense,
    allowDerivatives,
    allowCommercialUse,
    browsingMode,
    ids,
    needsReview,
    earlyAccess,
    supportsGeneration,
    followed,
    collectionId,
    fileFormats,
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
  if (allowCommercialUse !== undefined) {
    const commercialUseOr: CommercialUse[] = [];
    switch (allowCommercialUse) {
      case CommercialUse.None:
        commercialUseOr.push(CommercialUse.None);
        break;
      case CommercialUse.Image:
        commercialUseOr.push(CommercialUse.Image);
      case CommercialUse.RentCivit:
        commercialUseOr.push(CommercialUse.RentCivit);
      case CommercialUse.Rent:
        commercialUseOr.push(CommercialUse.Rent);
      case CommercialUse.Sell:
        commercialUseOr.push(CommercialUse.Sell);
    }
    AND.push({ allowCommercialUse: { in: commercialUseOr } });
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
  if (excludedIds && !hidden && !username) {
    AND.push({ id: { notIn: excludedIds } });
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

  if (!ignoreListedStatus) {
    // TODO: This might be more conditional than anything really.
    AND.push({
      OR: [
        {
          unlisted: false,
        },
        sessionUser
          ? {
              userId: sessionUser.id,
            }
          : undefined,
      ].filter(isDefined),
    });
  }

  const hideNSFWModels = browsingMode === BrowsingMode.SFW || !canViewNsfw;
  const where: Prisma.ModelWhereInput = {
    tagsOnModels: tagname ?? tag ? { some: { tag: { name: tagname ?? tag } } } : undefined,
    user: username || user ? { username: username ?? user } : undefined,
    type: types?.length ? { in: types } : undefined,
    nsfw: hideNSFWModels ? false : undefined,
    rank: rating
      ? {
          AND: [{ ratingAllTime: { gte: rating } }, { ratingAllTime: { lt: rating + 1 } }],
        }
      : undefined,
    engagements: favorites
      ? { some: { userId: sessionUser?.id, type: 'Favorite' } }
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

  let orderBy: Prisma.ModelOrderByWithRelationInput = {
    lastVersionAt: { sort: 'desc', nulls: 'last' },
  };

  if (sort === ModelSort.HighestRated) orderBy = { rank: { [`rating${period}Rank`]: 'asc' } };
  else if (sort === ModelSort.MostLiked)
    orderBy = { rank: { [`favoriteCount${period}Rank`]: 'asc' } };
  else if (sort === ModelSort.MostDownloaded)
    orderBy = { rank: { [`downloadCount${period}Rank`]: 'asc' } };
  else if (sort === ModelSort.MostDiscussed)
    orderBy = { rank: { [`commentCount${period}Rank`]: 'asc' } };
  else if (sort === ModelSort.MostCollected)
    orderBy = { rank: { [`collectedCount${period}Rank`]: 'asc' } };
  else if (sort === ModelSort.MostTipped)
    orderBy = { rank: { [`tippedAmountCount${period}Rank`]: 'asc' } };
  else if (sort === ModelSort.ImageCount)
    orderBy = { rank: { [`imageCount${period}Rank`]: 'asc' } };

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
  user?: { id: number; isModerator?: boolean; username?: string };
}) => {
  input.limit = input.limit ?? 100;
  const take = input.limit + 1;

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
    input: { ...input, take },
    user,
  });

  const modelVersionIds = items.flatMap((m) => m.modelVersions).map((m) => m.id);
  const clubRequirement = await entityRequiresClub({
    entityIds: modelVersionIds.map((id) => id),
    entityType: 'ModelVersion',
  });

  const images = !!modelVersionIds.length
    ? await getImagesForModelVersion({
        modelVersionIds,
        imagesPerVersion: 10,
        excludedTagIds: input.excludedImageTagIds,
        include: ['tags'],
        currentUserId: user?.id,
      })
    : [];

  // let nextCursor: number | undefined;
  // if (items.length > input.limit) {
  //   const nextItem = items.pop();
  //   nextCursor = nextItem?.id;
  // }

  const result = {
    nextCursor,
    isPrivate,
    items: items
      .map(({ hashes, modelVersions, rank, tagsOnModels, ...model }) => {
        const [version] = modelVersions;
        if (!version) return null;
        const versionImages = images.filter((i) => i.modelVersionId === version.id);
        const showImageless =
          (user?.isModerator || model.user.id === user?.id) && (input.user || input.username);
        if (!versionImages.length && !showImageless) return null;

        const canGenerate = !!version.generationCoverage?.covered;
        const requiresClub =
          clubRequirement.find((r) => r.entityId === version.id)?.requiresClub ?? false;
        return {
          ...model,
          tags: tagsOnModels.map((x) => x.tagId), // not sure why we even use scoring here...
          hashes: hashes.map((hash) => hash.hash.toLowerCase()),
          rank: {
            downloadCount: rank?.[`downloadCount${input.period}`] ?? 0,
            favoriteCount: rank?.[`favoriteCount${input.period}`] ?? 0,
            commentCount: rank?.[`commentCount${input.period}`] ?? 0,
            ratingCount: rank?.[`ratingCount${input.period}`] ?? 0,
            collectedCount: rank?.[`collectedCount${input.period}`] ?? 0,
            tippedAmountCount: rank?.[`tippedAmountCount${input.period}`] ?? 0,
            rating: rank?.[`rating${input.period}`] ?? 0,
          },
          version,
          images: model.mode !== ModelModifier.TakenDown ? (versionImages as typeof images) : [],
          canGenerate,
          requiresClub,
        };
      })
      .filter(isDefined),
  };

  return result;
};

export const getModelVersionsMicro = ({
  id,
  excludeUnpublished: excludeDrafts,
}: GetModelVersionsSchema) => {
  return dbRead.modelVersion.findMany({
    where: { modelId: id, status: excludeDrafts ? ModelStatus.Published : undefined },
    orderBy: { index: 'asc' },
    select: { id: true, name: true, index: true },
  });
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
      select: { id: true, userId: true, nsfw: true, modelVersions: { select: { id: true } } },
    });
    if (!model) return null;

    // TODO - account for case that a user restores a model and doesn't want all posts to be re-published
    await tx.post.updateMany({
      where: {
        userId: model.userId,
        modelVersionId: { in: model.modelVersions.map(({ id }) => id) },
      },
      data: { publishedAt: null },
    });

    await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);

    return model;
  });

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
      select: { id: true, userId: true, nsfw: true, modelVersions: { select: { id: true } } },
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

export const upsertModel = async ({
  id,
  tagsOnModels,
  userId,
  templateId,
  ...data
}: // TODO.manuel: hardcoding meta type since it causes type issues in lots of places if we set it in the schema
ModelUpsertInput & { userId: number; meta?: Prisma.ModelCreateInput['meta'] }) => {
  if (!id || templateId)
    return dbWrite.model.create({
      select: { id: true, nsfw: true },
      data: {
        ...data,
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
  else {
    if (tagsOnModels) {
      await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);
    }

    return dbWrite.model.update({
      select: { id: true, nsfw: true },
      where: { id },
      data: {
        ...data,
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
  let status: ModelStatus = ModelStatus.Published;
  if (publishedAt && publishedAt > new Date()) status = ModelStatus.Scheduled;
  else publishedAt = new Date();

  const model = await dbWrite.$transaction(
    async (tx) => {
      const includeVersions = versionIds && versionIds.length > 0;

      const model = await tx.model.update({
        where: { id },
        data: {
          status: republishing ? ModelStatus.Published : status,
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
        },
      });

      if (includeVersions) {
        await tx.post.updateMany({
          where: { modelVersionId: { in: versionIds } },
          data: { publishedAt },
        });

        // Send to orchestrator
        try {
          await Promise.all(
            model.modelVersions.map((version) =>
              prepareModelInOrchestrator({ id: version.id, baseModel: version.baseModel })
            )
          );
        } catch (e) {}
      }
      if (!republishing) await updateModelLastVersionAt({ id, tx });

      await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);

      return model;
    },
    { timeout: 10000 }
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
      const updatedModel = await tx.model.update({
        where: { id },
        data: {
          status: reason ? ModelStatus.UnpublishedViolation : ModelStatus.Unpublished,
          meta: {
            ...meta,
            ...(reason
              ? {
                  unpublishedReason: reason,
                  customMessage,
                }
              : {}),
            unpublishedAt: new Date().toISOString(),
            unpublishedBy: user.id,
          },
          modelVersions: {
            updateMany: {
              where: { status: { in: [ModelStatus.Published, ModelStatus.Scheduled] } },
              data: { status: ModelStatus.Unpublished },
            },
          },
        },
        select: { userId: true, modelVersions: { select: { id: true } } },
      });

      await tx.post.updateMany({
        where: {
          modelVersionId: { in: updatedModel.modelVersions.map((x) => x.id) },
          userId: updatedModel.userId,
          publishedAt: { not: null },
        },
        data: { publishedAt: null },
      });

      // Remove this model from search index as it's been unpublished.
      await modelsSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);

      return updatedModel;
    },
    { timeout: 10000 }
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

export const getModelsByCategory = async ({
  user,
  tag,
  tagname,
  cursor,
  ...input
}: GetModelsByCategoryInput & {
  user?: SessionUser;
}) => {
  input.limit ??= 10;
  let categories = await getTypeCategories({
    type: 'model',
    excludeIds: input.excludedTagIds,
    limit: input.limit + 1,
    cursor,
  });

  let nextCursor: number | null = null;
  if (categories.length > input.limit) nextCursor = categories.pop()?.id ?? null;
  categories = categories.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return Math.random() - 0.5;
  });

  const items = await Promise.all(
    categories.map((c) =>
      getModels({
        input: { ...input, tagname: c.name, take: input.modelLimit ?? 21 },
        user,
        // Can we make this into a select schema? (low pri)
        select: {
          id: true,
          name: true,
          type: true,
          nsfw: true,
          status: true,
          createdAt: true,
          lastVersionAt: true,
          publishedAt: true,
          locked: true,
          earlyAccessDeadline: true,
          mode: true,
          rank: {
            select: {
              [`downloadCount${input.period}`]: true,
              [`favoriteCount${input.period}`]: true,
              [`commentCount${input.period}`]: true,
              [`ratingCount${input.period}`]: true,
              [`rating${input.period}`]: true,
            },
          },
          modelVersions: {
            orderBy: { index: 'asc' },
            take: 1,
            select: {
              id: true,
              earlyAccessTimeFrame: true,
              createdAt: true,
              generationCoverage: { select: { covered: true } },
            },
          },
          user: { select: simpleUserSelect },
          hashes: {
            select: modelHashSelect,
            where: {
              hashType: ModelHashType.SHA256,
              fileType: { in: ['Model', 'Pruned Model'] as ModelFileType[] },
            },
          },
        },
      }).then(({ items }) => ({
        ...c,
        items,
      }))
    )
  );

  const modelVersionIds = items
    .flatMap((m) => m.items)
    .flatMap((m) => m.modelVersions)
    .map((m) => m.id);
  const images = !!modelVersionIds.length
    ? await getImagesForModelVersion({
        modelVersionIds,
        excludedTagIds: input.excludedImageTagIds,
        excludedIds: await getHiddenImagesForUser({ userId: user?.id }),
        excludedUserIds: input.excludedUserIds,
        currentUserId: user?.id,
      })
    : [];

  const result = {
    nextCursor,
    items: items.map(({ items, ...c }) => ({
      ...c,
      items: items
        .map(({ hashes, modelVersions, rank, ...model }) => {
          const [version] = modelVersions;
          if (!version) return null;
          const [image] = images.filter((i) => i.modelVersionId === version.id);
          if (!image) return null;

          const canGenerate = !!version.generationCoverage?.covered;

          return {
            ...model,
            hashes: hashes.map((hash) => hash.hash.toLowerCase()),
            rank: {
              downloadCount: rank?.[`downloadCount${input.period}`] ?? 0,
              favoriteCount: rank?.[`favoriteCount${input.period}`] ?? 0,
              commentCount: rank?.[`commentCount${input.period}`] ?? 0,
              ratingCount: rank?.[`ratingCount${input.period}`] ?? 0,
              rating: rank?.[`rating${input.period}`] ?? 0,
            },
            image:
              model.mode !== ModelModifier.TakenDown
                ? (image as (typeof images)[0] | undefined)
                : undefined,
            canGenerate,
          };
        })
        .filter(isDefined),
    })),
  };

  return result;
};

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
        select: { id: true, title: true, nsfw: true, user: { select: simpleUserSelect } },
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

export const getGalleryHiddenPreferences = async ({
  settings,
}: {
  settings: ModelGallerySettingsSchema;
}) => {
  const { tags, users, images } = settings;
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

  return { hiddenTags, hiddenUsers, hiddenImages: images ?? [] };
};
