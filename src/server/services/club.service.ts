import { dbWrite, dbRead } from '~/server/db/client';
import {
  GetClubTiersInput,
  GetInfiniteClubSchema,
  SupportedClubEntities,
  UpsertClubInput,
  UpsertClubResourceInput,
  UpsertClubTierInput,
} from '~/server/schema/club.schema';
import { Availability, ClubMembershipRole, Prisma } from '@prisma/client';
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

export const userContributingClubs = async ({
  userId,
  clubIds,
}: {
  userId: number;
  clubIds?: number[];
}) => {
  const clubs = await dbRead.club.findMany({
    select: {
      id: true,
      name: true,
      userId: true,
      memberships: {
        where: {
          userId,
        },
        select: {
          role: true,
          userId: true,
          clubId: true,
          unitAmount: true,
          clubTierId: true,
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
          memberships: {
            some: {
              userId,
              role: {
                in: [ClubMembershipRole.Admin, ClubMembershipRole.Contributor],
              },
            },
          },
        },
      ],
    },
  });

  return clubs.map((club) => ({
    ...club,
    membership: club.memberships[0],
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
    },
  });

  return {
    ...club,
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
  };
};

export function upsertClub({
  isModerator,
  userId,
  id,
  ...input
}: UpsertClubInput & {
  userId: number;
  isModerator: boolean;
}) {
  if (id) {
    // TODO: Update club
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
  const club = await dbWrite.$transaction(
    async (tx) => {
      await tx.club.findUniqueOrThrow({ where: { id } });
      const createdImages = await createEntityImages({
        tx,
        images: [coverImage, headerImage, avatar].filter((i) => !i?.id).filter(isDefined),
        userId,
      });

      const club = await tx.club.update({
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

      return club;
    },
    { maxWait: 10000, timeout: 30000 }
  );

  return club;
};

export const createClub = async ({
  coverImage,
  headerImage,
  avatar,
  tiers = [],
  deleteTierIds = [],
  userId,
  ...data
}: Omit<UpsertClubInput, 'id'> & {
  userId: number;
}) => {
  const club = await dbWrite.$transaction(
    async (tx) => {
      const createdImages = await createEntityImages({
        tx,
        images: [coverImage, headerImage, avatar].filter((i) => !i?.id).filter(isDefined),
        userId,
      });

      const club = await tx.club.create({
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

      // Create tiers:
      await upsertClubTiers({
        clubId: club.id,
        tiers,
        deleteTierIds,
        userId,
        tx,
      });

      return club;
    },
    { maxWait: 10000, timeout: 30000 }
  );

  return club;
};

export const upsertClubTiers = async ({
  clubId,
  tiers,
  deleteTierIds,
  tx,
  userId,
  isModerator,
}: {
  userId: number;
  isModerator?: boolean;
  clubId: number;
  tiers?: UpsertClubTierInput[];
  deleteTierIds?: number[];
  tx?: Prisma.TransactionClient;
}) => {
  const dbClient = tx ?? dbWrite;
  const club = await getClub({ id: clubId, userId });

  if (userId !== club?.userId && !isModerator) {
    throw throwBadRequestError('Only club owners can edit club tiers');
  }

  if ((deleteTierIds?.length ?? 0) > 0) {
    const deletingTierWithMembers = await dbClient.clubTier.findFirst({
      where: {
        id: {
          in: deleteTierIds,
        },
        memberships: {
          some: {},
        },
      },
      select: {
        id: true,
        name: true,
      },
    });

    if (deletingTierWithMembers) {
      throw throwBadRequestError(
        'Cannot delete tier with members. Please move the members out of this tier before deleting it.'
      );
    }

    await dbClient.clubTier.deleteMany({
      where: {
        id: {
          in: deleteTierIds,
        },
      },
    });
  }

  if (tiers && tiers.length > 0) {
    const createdImages = await createEntityImages({
      userId,
      images: tiers
        .filter((tier) => tier.coverImage?.id === undefined)
        .map((tier) => tier.coverImage)
        .filter(isDefined),
      tx: dbClient,
    });

    const toCreate = tiers.filter((tier) => !tier.id);
    if (toCreate.length > 0) {
      await dbClient.clubTier.createMany({
        data: toCreate.map(({ coverImage, ...tier }) => ({
          ...tier,
          clubId,
          coverImageId: coverImage?.id ?? createdImages.find((i) => i.url === coverImage?.url)?.id,
        })),
        skipDuplicates: true,
      });
    }

    const toUpdate = tiers.filter((tier) => tier.id !== undefined);
    if (toUpdate.length > 0) {
      await Promise.all(
        toUpdate.map((tier) => {
          const { id, coverImage, clubId, ...data } = tier;
          return dbClient.clubTier.update({
            where: {
              id: id as number,
            },
            data: {
              ...data,
              coverImageId:
                coverImage === null
                  ? null
                  : coverImage === undefined
                  ? undefined
                  : coverImage?.id ?? createdImages.find((i) => i.url === coverImage?.url)?.id,
            },
          });
        })
      );
    }
  }
};

export const getClubTiers = async ({
  clubId,
  clubIds,
  listedOnly,
  joinableOnly,
  include,
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
      _count: include?.includes('membershipsCount')
        ? {
            select: {
              memberships: true,
            },
          }
        : undefined,
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
  // First, check that the person is
  const [ownership] = await entityOwnership({ userId, entities: [{ entityType, entityId }] });

  if (!isModerator && !ownership.isOwner) {
    throw throwAuthorizationError('You do not have permission to add this resource to a club');
  }

  const clubIds = clubs.map((c) => c.clubId);
  const contributingClubs = await userContributingClubs({ userId, clubIds });
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
      entities: [
        {
          entityId,
          entityType,
        },
      ],
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
  await dbWrite.$transaction(async (tx) => {
    // Prisma doesn't do update or create with contraints... Need to delete all records and then add again
    await tx.entityAccess.deleteMany({
      where: {
        accessToId: entityId,
        accessToType: entityType,
        OR: [
          {
            accessorId: {
              in: clubIds,
            },
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

    const generalClubAccess = clubs.filter((c) => !c.clubTierIds || !c.clubTierIds.length);
    const tierClubAccess = clubs.filter((c) => c.clubTierIds && c.clubTierIds.length);
    const clubAccessIds = generalClubAccess.map((c) => c.clubId);
    const tierAccessIds = tierClubAccess
      .map((c) => c.clubTierIds)
      .filter(isDefined)
      .flat();

    // Add general club access:
    await tx.entityAccess.createMany({
      data: clubAccessIds.map((clubId) => ({
        accessToId: entityId,
        accessToType: entityType,
        accessorId: clubId,
        accessorType: 'Club',
        addedById: userId,
      })),
    });

    // Add tier club access:
    await tx.entityAccess.createMany({
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
  });
};

export const getClubDetailsForResource = async ({
  entities,
}: {
  entities: {
    entityType: SupportedClubEntities;
    entityId: number;
  }[];
}) => {
  const clubRequirements = await entityRequiresClub({ entities });
  return clubRequirements;
};

export const getAllClubs = <TSelect extends Prisma.ClubSelect>({
  input: { cursor, limit: take, sort, engagement, userId, nsfw },
  select,
}: {
  input: GetInfiniteClubSchema;
  select: TSelect;
}) => {
  const AND: Prisma.Enumerable<Prisma.ClubWhereInput> = [];

  if (userId && engagement) {
    if (engagement === 'owned') AND.push({ userId });
    if (engagement === 'memberships')
      AND.push({
        memberships: {
          some: {
            userId,
          },
        },
      });
  }

  if (!userId) {
    AND.push({ unlisted: false });
  }

  const orderBy: Prisma.ClubFindManyArgs['orderBy'] = [];
  orderBy.push({ id: 'desc' });

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
