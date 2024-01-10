import { dbRead, dbWrite } from '~/server/db/client';
import {
  GetClubTiersInput,
  GetInfiniteClubSchema,
  GetPaginatedClubResourcesSchema,
  RemoveClubResourceInput,
  SupportedClubEntities,
  UpdateClubResourceInput,
  UpsertClubInput,
  UpsertClubResourceInput,
  UpsertClubTierInput,
} from '~/server/schema/club.schema';
import { Availability, ClubAdminPermission, Prisma } from '@prisma/client';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import { createEntityImages } from '~/server/services/image.service';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { isDefined } from '~/utils/type-guards';
import { GetByIdInput } from '~/server/schema/base.schema';
import { imageSelect } from '~/server/selectors/image.selector';
import {
  entityAvailabilityUpdate,
  entityOwnership,
  entityRequiresClub,
} from '~/server/services/common.service';
import { getPagingData } from '~/server/utils/pagination-helpers';
import { createBuzzTransaction, getUserBuzzAccount } from '~/server/services/buzz.service';
import { TransactionType } from '~/server/schema/buzz.schema';
import { userWithCosmeticsSelect } from '../selectors/user.selector';
import { bustCacheTag } from '../utils/cache-helpers';
import { isEqual } from 'lodash-es';
import { ClubSort } from '../common/enums';
import { clubMetrics } from '../metrics';

export const userContributingClubs = async ({
  userId,
  clubIds,
  tx,
}: {
  userId: number;
  clubIds?: number[];
  tx?: Prisma.TransactionClient;
}) => {
  const dbClient = tx ?? dbRead;
  const clubs = await dbClient.club.findMany({
    select: {
      id: true,
      name: true,
      userId: true,
      admins: {
        where: {
          userId,
        },
        select: {
          clubId: true,
          permissions: true,
        },
      },
    },
    where: {
      id: clubIds ? { in: clubIds } : undefined,
      OR: [
        {
          userId,
        },
        {
          admins: {
            some: { userId },
          },
        },
      ],
    },
  });

  return clubs.map((club) => ({
    ...club,
    admin: club.admins[0],
  }));
};

export const getClub = async ({
  id,
  tx,
}: GetByIdInput & {
  userId?: number;
  isModerator?: boolean;
  tx?: Prisma.TransactionClient;
}) => {
  const dbClient = tx ?? dbRead;
  const club = await dbClient.club.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      name: true,
      description: true,
      avatar: { select: imageSelect },
      coverImage: { select: imageSelect },
      headerImage: { select: imageSelect },
      nsfw: true,
      billing: true,
      unlisted: true,
      userId: true,
      user: {
        select: userWithCosmeticsSelect,
      },
      tiers: {
        take: 1,
        where: {
          unlisted: false,
          joinable: true,
        },
      },
      posts: {
        take: 1,
      },
      stats: {
        select: {
          clubPostCountAllTime: true,
          memberCountAllTime: true,
          resourceCountAllTime: true,
        },
      },
    },
  });

  const { tiers, posts, ...data } = club;

  return {
    ...data,
    avatar: club.avatar
      ? {
          ...club.avatar,
          meta: club.avatar.meta as ImageMetaProps,
          metadata: club.avatar.metadata as MixedObject,
        }
      : club.avatar,
    coverImage: club.coverImage
      ? {
          ...club.coverImage,
          meta: club.coverImage.meta as ImageMetaProps,
          metadata: club.coverImage.metadata as MixedObject,
        }
      : club.coverImage,
    headerImage: club.headerImage
      ? {
          ...club.headerImage,
          meta: club.headerImage.meta as ImageMetaProps,
          metadata: club.headerImage.metadata as MixedObject,
        }
      : club.headerImage,
    hasTiers: tiers.length > 0,
    hasPosts: posts.length > 0,
  };
};

export async function upsertClub({
  isModerator,
  userId,
  id,
  ...input
}: UpsertClubInput & {
  userId: number;
  isModerator: boolean;
}) {
  if (id) {
    // Check for permission:
    const [club] = await userContributingClubs({ userId });

    if (!club && !isModerator) {
      throw throwAuthorizationError('You do not have permission to edit this club');
    }

    const isOwner = club.userId === userId;
    const canManageClub =
      club.admin && club.admin.permissions.includes(ClubAdminPermission.ManageClub);

    if (!isOwner && !canManageClub && !isModerator) {
      throw throwAuthorizationError('You do not have permission to edit this club');
    }

    return updateClub({ ...input, id, userId });
  } else {
    return createClub({ ...input, userId });
  }
}

export const updateClub = async ({
  coverImage,
  headerImage,
  avatar,
  id,
  userId,
  ...data
}: Omit<UpsertClubInput, 'tiers' | 'deleteTierIds'> & {
  id: number;
  userId: number;
}) => {
  const existingClub = await dbWrite.club.findUniqueOrThrow({ where: { id } });
  const createdImages = await createEntityImages({
    images: [coverImage, headerImage, avatar].filter((i) => !i?.id).filter(isDefined),
    userId,
  });

  const club = await dbWrite.club.update({
    where: { id },
    data: {
      ...data,
      avatarId:
        avatar === null
          ? null
          : avatar !== undefined
          ? avatar?.id ?? createdImages.find((i) => i.url === avatar.url)?.id
          : undefined,
      coverImageId:
        coverImage === null
          ? null
          : coverImage !== undefined
          ? coverImage?.id ?? createdImages.find((i) => i.url === coverImage.url)?.id
          : undefined,
      headerImageId:
        headerImage === null
          ? null
          : headerImage !== undefined
          ? headerImage?.id ?? createdImages.find((i) => i.url === headerImage.url)?.id
          : undefined,
    },
  });

  if (data.billing !== undefined && existingClub.billing !== data.billing) {
    // Notify users...
    const notificationQuery = Prisma.sql`
    WITH data AS (
        SELECT
          c.id "clubId",
          c.name "clubName",
          c.billing,
          cm."userId",
          cm."nextBillingAt"
        FROM "ClubMembership" cm
        JOIN "Club" c ON cm."clubId" = c.id
        JOIN "ClubTier" ct ON cm."clubTierId" = ct.id
        WHERE ct."oneTimeFee" = false AND cm."expiresAt" IS NULL AND cm."cancelledAt" IS NULL AND cm."nextBillingAt" IS NOT NULL
      )
      INSERT INTO "Notification"("id", "userId", "type", "details")
        SELECT
          REPLACE(gen_random_uuid()::text, '-', ''),
          "userId",
          'club-billing-toggled' "type",
          jsonb_build_object(
            'clubId', "clubId",
            'clubName', "clubName",
            'billing', "billing",
            'nextBillingAt', "nextBillingAt"
          )
        FROM data
      ON CONFLICT("id") DO NOTHING;
      `;

    await dbWrite.$executeRaw(notificationQuery);
  }

  return club;
};

export const createClub = async ({
  coverImage,
  headerImage,
  avatar,
  userId,
  ...data
}: Omit<UpsertClubInput, 'id'> & {
  userId: number;
}) => {
  const createdImages = await createEntityImages({
    images: [coverImage, headerImage, avatar].filter((i) => !i?.id).filter(isDefined),
    userId,
  });

  const club = await dbWrite.club.create({
    data: {
      ...data,
      userId,
      avatarId:
        avatar === null
          ? null
          : avatar !== undefined
          ? avatar?.id ?? createdImages.find((i) => i.url === avatar.url)?.id
          : undefined,
      coverImageId:
        coverImage === null
          ? null
          : coverImage !== undefined
          ? coverImage?.id ?? createdImages.find((i) => i.url === coverImage.url)?.id
          : undefined,
      headerImageId:
        headerImage === null
          ? null
          : headerImage !== undefined
          ? headerImage?.id ?? createdImages.find((i) => i.url === headerImage.url)?.id
          : undefined,
    },
  });

  return club;
};

export const upsertClubTier = async ({
  clubId,
  tier,
  userId,
  isModerator,
}: {
  clubId: number;
  userId: number;
  isModerator?: boolean;
  tier: UpsertClubTierInput;
}) => {
  const [userClub] = await userContributingClubs({ userId, clubIds: [clubId] });

  // Check that the user can actually add tiers to this club
  if (
    userId !== userClub?.userId &&
    !isModerator &&
    !userClub?.admin?.permissions?.includes(ClubAdminPermission.ManageTiers)
  ) {
    throw throwBadRequestError('Only club owners can edit club tiers');
  }

  const { coverImage, ...data } = tier;

  const shouldCreateImage = coverImage && !coverImage.id;

  const [imageRecord] = shouldCreateImage
    ? await createEntityImages({
        userId,
        images: [coverImage],
      })
    : [];

  if (data.id) {
    const existingClubTier = await dbRead.clubTier.findUnique({
      where: {
        id: data.id,
      },
    });

    if (!existingClubTier) {
      throw throwBadRequestError('Club tier not found');
    }

    const hasMembers = await dbRead.clubTier.findFirst({
      where: {
        id: data.id,
        memberships: {
          some: {},
        },
      },
    });

    if (existingClubTier.unitAmount > data.unitAmount && hasMembers) {
      throw throwBadRequestError(
        'Cannot downgrade tier with members. Please move the members out of this tier before downgrading it.'
      );
    }

    if (existingClubTier.oneTimeFee !== data.oneTimeFee && hasMembers) {
      throw throwBadRequestError(
        'Cannot change one time payment status of a tier with members. Please move the members out of this tier before changing its one time payment status.'
      );
    }

    return await dbWrite.clubTier.update({
      where: {
        id: data.id,
      },
      data: {
        ...data,
        coverImageId:
          coverImage === null
            ? null
            : coverImage === undefined
            ? undefined
            : coverImage?.id ?? imageRecord?.id,
      },
    });
  } else {
    return dbWrite.clubTier.create({
      data: {
        ...data,
        clubId,
        coverImageId: coverImage?.id ?? imageRecord?.id,
      },
    });
  }
};

export const deleteClubTier = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & {
  userId: number;
  isModerator?: boolean;
}) => {
  const clubTier = await dbRead.clubTier.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      clubId: true,
      _count: {
        select: {
          memberships: {
            where: {
              OR: [
                {
                  expiresAt: null,
                },
                {
                  expiresAt: {
                    gt: new Date(),
                  },
                },
              ],
            },
          },
        },
      },
    },
  });

  const [userClub] = await userContributingClubs({ userId, clubIds: [clubTier.clubId] });

  if (
    userId !== userClub?.userId &&
    !isModerator &&
    !userClub?.admin?.permissions?.includes(ClubAdminPermission.ManageTiers)
  ) {
    throw throwBadRequestError(
      'Only club owners and admins with manage tier access can delete club tiers'
    );
  }

  if (clubTier._count.memberships > 0) {
    throw throwBadRequestError(
      'Cannot delete tier with members. Please remove the members out of this tier before deleting it.'
    );
  }

  await dbWrite.clubTier.delete({
    where: {
      id,
    },
  });

  // Check resources that require this tier:
  const clubTierResources = await dbRead.entityAccess.findMany({
    where: {
      accessorId: id,
      accessorType: 'ClubTier',
    },
    select: {
      accessToId: true,
      accessToType: true,
    },
  });

  if (clubTierResources.length === 0) {
    // No resources require this tier.
    return;
  }

  // Remove this tier requirement.
  await dbWrite.entityAccess.deleteMany({
    where: {
      accessorId: id,
      accessorType: 'ClubTier',
    },
  });

  // Group by type:
  const resourcesByType = clubTierResources.reduce((acc, curr) => {
    if (!acc[curr.accessToType]) {
      acc[curr.accessToType] = [];
    }

    acc[curr.accessToType].push(curr.accessToId);

    return acc;
  }, {} as any);

  // Check some of the tier resources it still require some special access:
  const entitiesWithAccessAfterDelete = await dbWrite.entityAccess.findMany({
    where: {
      OR: Object.keys(resourcesByType).map((type) => ({
        accessToId: {
          in: resourcesByType[type],
        },
        accessToType: type as SupportedClubEntities,
      })),
    },
  });

  const entitiesWithoutAccess = clubTierResources.filter(
    (r) =>
      !entitiesWithAccessAfterDelete.find(
        (e) => e.accessToType === r.accessToType && e.accessToId === r.accessToId
      )
  );

  if (entitiesWithoutAccess.length === 0) {
    // All resources still require access to some clubs / other
    return;
  }

  const entitiesWithoutAccessByType = entitiesWithoutAccess.reduce((acc, curr) => {
    if (!acc[curr.accessToType]) {
      acc[curr.accessToType] = [];
    }

    acc[curr.accessToType].push(curr.accessToId);

    return acc;
  }, {} as any);

  await Promise.all(
    Object.keys(entitiesWithoutAccessByType).map((type) => {
      return entityAvailabilityUpdate({
        entityType: type as SupportedClubEntities,
        entityIds: entitiesWithoutAccessByType[type],
        availability: Availability.Public,
      });
    })
  );
};

export const getClubTiers = async ({
  clubId,
  clubIds,
  listedOnly,
  joinableOnly,
  userId,
  isModerator,
  tierId,
}: GetClubTiersInput & {
  userId?: number;
  isModerator?: boolean;
}) => {
  if (!clubId && !clubIds?.length) {
    return [];
  }

  const userClubs = userId ? await userContributingClubs({ userId }) : [];
  const userClubIds = userClubs.map((c) => c?.id);

  // Only if the user can actually view all tiers, we can ignore the listedOnly and joinableOnly flags:
  const canViewAllTiers =
    isModerator ||
    (userClubIds.includes(clubId ?? -1) && !(clubIds ?? []).some((c) => !userClubIds.includes(c)));

  if (!canViewAllTiers) {
    listedOnly = true;
    joinableOnly = true;
  }

  const tiers = await dbRead.clubTier.findMany({
    where: {
      clubId: clubId ? clubId : clubIds ? { in: clubIds } : undefined,
      unlisted: listedOnly !== undefined ? !listedOnly : undefined,
      joinable: joinableOnly !== undefined ? joinableOnly : undefined,
      id: tierId || undefined,
    },
    select: {
      id: true,
      name: true,
      description: true,
      coverImage: {
        select: imageSelect,
      },
      unitAmount: true,
      currency: true,
      clubId: true,
      joinable: true,
      unlisted: true,
      memberLimit: true,
      oneTimeFee: true,
      _count: {
        select: {
          memberships: true,
        },
      },
    },
    orderBy: {
      unitAmount: 'asc',
    },
  });

  return tiers.map((t) => ({
    ...t,
    coverImage: t.coverImage
      ? {
          ...t.coverImage,
          meta: t.coverImage.meta as ImageMetaProps,
          metadata: t.coverImage.metadata as MixedObject,
        }
      : t.coverImage,
  }));
};

export const upsertClubResource = async ({
  userId,
  isModerator,
  entityType,
  entityId,
  clubs,
}: UpsertClubResourceInput & {
  userId: number;
  isModerator?: boolean;
}) => {
  if (true) {
    return; // Disabled for now
  }

  const [clubRequirement] = await entityRequiresClub({
    entityType,
    entityIds: [entityId],
  });

  if (isEqual(clubRequirement?.clubs ?? [], clubs)) {
    // No change:
    return;
  }

  // First, check that the person is
  const [ownership] = await entityOwnership({ userId, entityIds: [entityId], entityType });

  if (!isModerator && !ownership.isOwner) {
    throw throwAuthorizationError('You do not have permission to add this resource to a club');
  }

  const clubIds = clubs.map((c) => c.clubId);
  const contributingClubs = await userContributingClubs({ userId, clubIds });

  await clubMetrics.queueUpdate(clubIds);

  if (!isModerator && clubIds.some((c) => !contributingClubs.find((cc) => cc.id === c))) {
    throw throwAuthorizationError(
      'You do not have permission to add this resource to one of the provided clubs'
    );
  }

  const clubTiers = clubIds.length
    ? await dbRead.clubTier.findMany({
        where: {
          clubId: {
            in: clubIds,
          },
        },
      })
    : [];

  const clubTierIds = clubTiers.map((t) => t.id);

  if (clubIds.length === 0) {
    // this resource will be made public:
    const [details] = await getClubDetailsForResource({
      entityIds: [entityId],
      entityType,
    });

    await dbWrite.entityAccess.deleteMany({
      where: {
        accessToId: entityId,
        accessToType: entityType,
        OR: [
          {
            accessorId: {
              in: details.clubs.map((c) => c.clubId),
            },
            accessorType: 'Club',
          },
          {
            accessorId: {
              in: details.clubs
                .map((c) => c.clubTierIds)
                .filter(isDefined)
                .flat(),
            },
            accessorType: 'ClubTier',
          },
        ],
      },
    });

    // Check that no other access exists:
    const access = await dbWrite.entityAccess.findFirst({
      where: {
        accessToId: entityId,
        accessToType: entityType,
      },
    });

    if (entityType === 'Post') {
      await Promise.all(clubs.map((c) => bustCacheTag(`posts-club:${c.clubId}`)));
    }

    if (access) {
      // Some access type - i.e, user access, is still there.
      return;
    }

    await entityAvailabilityUpdate({
      entityType,
      entityIds: [entityId],
      availability: Availability.Public,
    });

    return;
  }

  // Now, add and/or remove it from clubs:
  // Prisma doesn't do update or create with contraints... Need to delete all records and then add again
  await dbWrite.entityAccess.deleteMany({
    where: {
      accessToId: entityId,
      accessToType: entityType,

      accessorType: {
        // Do not delete user access:
        in: ['Club', 'ClubTier'],
      },
    },
  });

  const generalClubAccess = clubs.filter((c) => !c.clubTierIds || !c.clubTierIds.length);
  const tierClubAccess = clubs.filter((c) => c.clubTierIds && c.clubTierIds.length);
  const clubAccessIds = generalClubAccess.map((c) => c.clubId);
  const tierAccessIds = tierClubAccess
    .map((c) => c.clubTierIds)
    .filter(isDefined)
    .flat();

  // Add general club access:
  await dbWrite.entityAccess.createMany({
    data: clubAccessIds.map((clubId) => ({
      accessToId: entityId,
      accessToType: entityType,
      accessorId: clubId,
      accessorType: 'Club',
      addedById: userId,
    })),
  });

  // Add tier club access:
  await dbWrite.entityAccess.createMany({
    data: tierAccessIds.map((clubTierId) => ({
      accessToId: entityId,
      accessToType: entityType,
      accessorId: clubTierId,
      accessorType: 'ClubTier',
      addedById: userId,
    })),
  });

  await entityAvailabilityUpdate({
    entityType,
    entityIds: [entityId],
    availability: Availability.Private,
  });

  // Bust caches when items are added to clubs:
  if (entityType === 'Post') {
    await Promise.all(clubs.map((c) => bustCacheTag(`posts-club:${c.clubId}`)));
  }
};

export const getClubDetailsForResource = async ({
  entityIds,
  entityType,
}: {
  entityType: SupportedClubEntities;
  entityIds: number[];
}) => {
  const clubRequirement = await entityRequiresClub({
    entityType,
    entityIds,
  });

  return clubRequirement;
};

export const getAllClubs = <TSelect extends Prisma.ClubSelect>({
  input: { cursor, limit: take, sort, engagement, userId, nsfw, clubIds },
  select,
}: {
  input: GetInfiniteClubSchema;
  select: TSelect;
}) => {
  const AND: Prisma.Enumerable<Prisma.ClubWhereInput> = [];

  if (clubIds) {
    AND.push({
      id: {
        in: clubIds,
      },
    });
  }

  if (userId) {
    if (engagement) {
      if (engagement === 'engaged')
        AND.push({
          OR: [
            { userId },
            {
              memberships: {
                some: {
                  userId,
                },
              },
            },
            {
              admins: {
                some: {
                  userId,
                },
              },
            },
          ],
        });
    } else {
      // Your created clubs or public clubs:
      AND.push({
        OR: [
          {
            userId,
          },
          {
            unlisted: false,
            posts: {
              some: {},
            },
            tiers: {
              some: {},
            },
          },
        ],
      });
    }
  }

  if (!userId) {
    AND.push({
      unlisted: false,
      posts: {
        some: {},
      },
      tiers: {
        some: {},
      },
    });
  }

  const orderBy: Prisma.ClubFindManyArgs['orderBy'] = [];
  if (sort === ClubSort.MostMembers) {
    orderBy.push({ rank: { memberCountAllTimeRank: 'asc' } });
  } else if (sort === ClubSort.MostPosts) {
    orderBy.push({ rank: { clubPostCountAllTimeRank: 'asc' } });
  } else if (sort === ClubSort.MostResources) {
    orderBy.push({ rank: { resourceCountAllTimeRank: 'asc' } });
  } else {
    orderBy.push({ id: 'desc' });
  }

  return dbRead.club.findMany({
    take,
    cursor: cursor ? { id: cursor } : undefined,
    select,
    where: {
      nsfw,
      AND,
    },
    orderBy,
  });
};

type ModelVersionClubResource = {
  entityType: 'ModelVersion';
  data: {
    id: number;
    name: string;
    modelVersion: {
      id: number;
      name: string;
    };
  };
};

type Article = {
  entityType: 'Article';
  data: {
    id: number;
    title: string;
  };
};

type Post = {
  entityType: 'Post';
  data: {
    id: number;
    title: string;
  };
};

type PaginatedClubResource = {
  entityId: number;
  entityType: string;
  clubId: number;
  clubTierIds: number[];
} & (ModelVersionClubResource | Article | Post);

export const getPaginatedClubResources = async ({
  clubId,
  clubTierId,
  page,
  limit,
}: GetPaginatedClubResourcesSchema) => {
  const AND: Prisma.Sql[] = [Prisma.raw(`(ct."id" IS NOT NULL OR c.id IS NOT NULL)`)];

  if (clubTierId) {
    // Use exists here rather than a custom join or smt so that we can still capture other tiers this item is available on.
    AND.push(
      Prisma.raw(
        `EXISTS (SELECT 1 FROM "EntityAccess" eat WHERE eat."accessorType" = 'ClubTier' AND eat."accessorId" = ${clubTierId})`
      )
    );
  }

  const fromQuery = Prisma.sql`
  FROM "EntityAccess" ea 
    LEFT JOIN "ClubTier" ct ON ea."accessorType" = 'ClubTier' AND ea."accessorId" = ct."id" AND ct."clubId" = ${clubId}  
    LEFT JOIN "Club" c ON ea."accessorType" = 'Club' AND ea."accessorId" = c.id AND c."id" = ${clubId}
    LEFT JOIN "ModelVersion" mv ON mv."id" = ea."accessToId" AND ea."accessToType" = 'ModelVersion'
    LEFT JOIN "Model" m ON m."id" = mv."modelId"
    LEFT JOIN "Article" a ON a."id" = ea."accessToId" AND ea."accessToType" = 'Article'
    LEFT JOIN "Post" p ON p."id" = ea."accessToId" AND ea."accessToType" = 'Post'
    
    WHERE ${Prisma.join(AND, ' AND ')}
  `;

  const [row] = await dbRead.$queryRaw<{ count: number }[]>`
    SELECT COUNT(DISTINCT CONCAT(ea."accessToId", ea."accessToType"))::INT as "count"
    ${fromQuery}
  `;

  const items = await dbRead.$queryRaw<PaginatedClubResource[]>`
    SELECT 
      ea."accessToId" as "entityId", 
      ea."accessToType" as "entityType",
      ${clubId}::INT as "clubId",
      COALESCE(
        json_agg(ct."id") FILTER (WHERE ct."id" IS NOT NULL),
        '[]'
      ) as "clubTierIds",
      CASE 
        WHEN ea."accessToType" = 'ModelVersion' THEN jsonb_build_object(
          'id', m."id",
          'name', m."name",
          'modelVersion', jsonb_build_object(
            'id', mv."id",
            'name', mv."name"
          )
        ) 
        WHEN ea."accessToType" = 'Article' THEN jsonb_build_object(
          'id', a."id",
          'title', a."title"
        )
        WHEN ea."accessToType" = 'Post' THEN jsonb_build_object(
          'id', p."id",
          'title', COALESCE(p."title", 'Image Post')
        )
        ELSE '{}'::jsonb
      END
      as "data"
    
    ${fromQuery}
    GROUP BY "entityId", "entityType", m."id", mv."id", a."id", p."id"
    ORDER BY ea."accessToId" DESC
    LIMIT ${limit} OFFSET ${(page - 1) * limit}
  `;

  return getPagingData({ items, count: (row?.count as number) ?? 0 }, limit, page);
};

export const updateClubResource = async ({
  userId,
  isModerator,
  entityType,
  entityId,
  clubId,
  clubTierIds,
}: UpdateClubResourceInput & {
  userId: number;
  isModerator?: boolean;
}) => {
  // First, check that the person is
  const [ownership] = await entityOwnership({ userId, entityType, entityIds: [entityId] });

  if (!isModerator && !ownership.isOwner) {
    throw throwAuthorizationError('You do not have permission to add this resource to a club');
  }

  const contributingClubs = await userContributingClubs({ userId, clubIds: [clubId] });

  if (!isModerator && !contributingClubs.find((cc) => cc.id === clubId)) {
    throw throwAuthorizationError(
      'You do not have permission to add this resource to one of the provided clubs'
    );
  }

  const clubTiers = await dbRead.clubTier.findMany({
    where: {
      clubId,
    },
  });

  const allClubTierIds = clubTiers.map((t) => t.id);

  // Prisma doesn't do update or create with contraints... Need to delete all records and then add again
  await dbWrite.entityAccess.deleteMany({
    where: {
      accessToId: entityId,
      accessToType: entityType,
      OR: [
        {
          accessorId: clubId,
          accessorType: 'Club',
        },
        {
          accessorId: {
            in: allClubTierIds,
          },
          accessorType: 'ClubTier',
        },
      ],
    },
  });

  const isGeneralClubAccess = (clubTierIds ?? []).length === 0;
  // Add general club access:
  if (isGeneralClubAccess) {
    await dbWrite.entityAccess.create({
      data: {
        accessToId: entityId,
        accessToType: entityType,
        accessorId: clubId,
        accessorType: 'Club',
        addedById: userId,
      },
    });
  } else {
    // Add tier club access:
    await dbWrite.entityAccess.createMany({
      data: (clubTierIds ?? []).map((clubTierId) => ({
        accessToId: entityId,
        accessToType: entityType,
        accessorId: clubTierId,
        accessorType: 'ClubTier',
        addedById: userId,
      })),
    });
  }
};

export const removeClubResource = async ({
  userId,
  isModerator,
  entityType,
  entityId,
  clubId,
}: RemoveClubResourceInput & {
  userId: number;
  isModerator?: boolean;
}) => {
  const [userClub] = await userContributingClubs({ userId, clubIds: [clubId] });
  const [ownership] = await entityOwnership({ userId, entityType, entityIds: [entityId] });
  const canRemoveResource =
    isModerator ||
    ownership.isOwner ||
    userClub?.userId === userId ||
    userClub.admin?.permissions.includes(ClubAdminPermission.ManageResources);

  if (!canRemoveResource) {
    throw throwAuthorizationError(
      'You do not have permission to remove this resource from this club'
    );
  }

  const clubTiers = await dbRead.clubTier.findMany({
    where: {
      clubId,
    },
  });

  const clubTierIds = clubTiers.map((t) => t.id);

  // Prisma doesn't do update or create with contraints... Need to delete all records and then add again
  await dbWrite.entityAccess.deleteMany({
    where: {
      accessToId: entityId,
      accessToType: entityType,
      OR: [
        {
          accessorId: clubId,
          accessorType: 'Club',
        },
        {
          accessorId: {
            in: clubTierIds,
          },
          accessorType: 'ClubTier',
        },
      ],
    },
  });

  await clubMetrics.queueUpdate(clubId);

  // Check if it still requires club access:
  const access = await dbWrite.entityAccess.findFirst({
    where: {
      accessToId: entityId,
      accessToType: entityType,
    },
  });

  if (access) {
    // Some access type - i.e, user access, is still there.
    return;
  }

  // Make this resource public:
  await entityAvailabilityUpdate({
    entityType,
    entityIds: [entityId],
    availability: Availability.Public,
  });
};

export const deleteClub = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId: number; isModerator: boolean }) => {
  const club = await getClub({ id, userId, isModerator: true });
  if (!club) {
    throw throwBadRequestError('Club does not exist');
  }

  if (club.userId !== userId && !isModerator) {
    throw throwBadRequestError('Only club owners can delete clubs');
  }

  const buzzAccount = await getUserBuzzAccount({ accountId: club.id, accountType: 'Club' });

  if ((buzzAccount?.balance ?? 0) > 0) {
    await createBuzzTransaction({
      toAccountId: club.userId,
      fromAccountId: club.id,
      fromAccountType: 'Club',
      type: TransactionType.Tip,
      amount: buzzAccount.balance as number,
    });
  }

  return dbWrite.club.delete({
    where: {
      id,
    },
  });
};
