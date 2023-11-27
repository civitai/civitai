import { dbWrite, dbRead } from '~/server/db/client';
import {
  GetClubEntityInput,
  GetClubTiersInput,
  SupportedClubEntities,
  UpsertClubEntityInput,
  UpsertClubInput,
  UpsertClubTierInput,
} from '~/server/schema/club.schema';
import { BountyDetailsSchema, CreateBountyInput } from '~/server/schema/bounty.schema';
import {
  Availability,
  BountyEntryMode,
  ClubMembershipRole,
  Currency,
  Prisma,
  TagTarget,
} from '@prisma/client';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import { createEntityImages, getEntityCoverImage } from '~/server/services/image.service';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { isDefined } from '~/utils/type-guards';
import { GetByIdInput } from '~/server/schema/base.schema';
import { imageSelect } from '~/server/selectors/image.selector';
import {
  entityAvailabilityUpdate,
  entityOwnership,
  entityRequiresClub,
  hasEntityAccess,
} from '~/server/services/common.service';
import { getHtmlContentPreview } from '~/utils/html-helpers';
import { UserWithCosmetics, userWithCosmeticsSelect } from '~/server/selectors/user.selector';

export const userContributingClubs = async ({
  userId,
  clubId,
}: {
  userId: number;
  clubId?: number;
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
          clubId: true,
          role: true,
        },
      },
    },
    where: {
      id: clubId,
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

  return clubs;
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
  const club = await getClub({ id: clubId });

  if (userId !== club?.userId && !isModerator) {
    listedOnly = true;
    joinableOnly = true;
  }

  const tiers = await dbRead.clubTier.findMany({
    where: {
      clubId,
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

type ClubEntityByEntityIdWithAccess = {
  type: 'hasAccess';
  hasAccess: true;
  title: string;
  description: string;
  coverImage: null | Awaited<ReturnType<typeof getEntityCoverImage>>[number];
};

type ClubEntityByEntityIdMembersOnlyNoAccess = {
  type: 'membersOnlyNoAccess';
  hasAccess: false;
  membersOnly: true;
  title: null;
  description: null;
  coverImage: null;
  membership: null;
};

type ClubEntityByEntityIdNonMembersOnlyNoAccess = {
  type: 'noAccess';
  hasAccess: false;
  title: string;
  description: string;
  coverImage: null | { id: number; hash: string; width: number; height: number };
};

type ClubEntityByEntityId = {
  clubId: number;
  entityId: number;
  entityType: SupportedClubEntities;
  type: 'hasAccess' | 'membersOnlyNoAccess' | 'noAccess';
  availability: Availability;
  availableInTierIds: number[];
  membersOnly: boolean;
  title: string | null;
  description: string | null;
  membership: null | { clubTierId: number };
  addedAt: Date;
  addedBy: UserWithCosmetics | null;
} & (
  | ClubEntityByEntityIdWithAccess
  | ClubEntityByEntityIdMembersOnlyNoAccess
  | ClubEntityByEntityIdNonMembersOnlyNoAccess
);
export const getClubEntity = async ({
  clubId,
  entityId,
  entityType,
  userId,
  isModerator,
  tx,
}: GetClubEntityInput & {
  userId?: number;
  isModerator?: boolean;
  tx?: Prisma.TransactionClient;
}): Promise<ClubEntityByEntityId | null> => {
  const dbClient = tx ?? dbRead;
  const club = await getClub({ id: clubId, tx: dbClient });
  const clubEntity = await dbClient.clubEntity.findFirst({
    where: {
      entityId,
      entityType,
      clubId,
    },
    select: {
      clubId: true,
      title: true,
      description: true,
      membersOnly: true,
      addedAt: true,
      addedBy: {
        select: userWithCosmeticsSelect,
      },
    },
  });

  if (!clubEntity) {
    return null;
  }

  const [entityClubRequirement] = await entityRequiresClub({
    entityIds: [entityId],
    entityType,
    clubId,
  });

  const availableInTierIds = (entityClubRequirement?.clubs ?? [])
    .map((c) => c.clubTierId)
    .filter(isDefined);
  const availability = entityClubRequirement?.availability ?? Availability.Public;

  if (!userId && clubEntity.membersOnly) {
    return {
      type: 'membersOnlyNoAccess',
      entityType,
      entityId,
      ...clubEntity,
      membersOnly: true,
      title: null,
      description: null,
      membership: null,
      hasAccess: false,
      availableInTierIds,
      coverImage: null,
      availability,
    };
  }

  const membership = await dbClient.clubMembership.findFirst({
    where: {
      clubId,
      userId,
      startedAt: { gte: new Date() },
      expiresAt: { lte: new Date() },
    },
  });

  const isOwner = club.userId === userId;

  if (!isModerator && !isOwner && !membership && clubEntity.membersOnly) {
    return {
      type: 'membersOnlyNoAccess',
      entityType,
      entityId,
      ...clubEntity,
      membersOnly: true,
      title: null,
      description: null,
      membership: null,
      hasAccess: false,
      availableInTierIds,
      coverImage: null,
      availability,
    };
  }

  const [coverImage] = await getEntityCoverImage({
    entities: [
      {
        entityId,
        entityType,
      },
    ],
    include: ['tags'],
  });

  const [entityAccess] = await hasEntityAccess({
    entityIds: [entityId],
    entityType,
    userId,
    isModerator,
  });

  const { hasAccess } = entityAccess;

  if (hasAccess) {
    return {
      type: 'hasAccess',
      hasAccess: true,
      entityType,
      entityId,
      ...clubEntity,
      membership,
      coverImage: !coverImage ? null : coverImage,
      availableInTierIds,
      availability,
    };
  }

  return {
    type: 'noAccess',
    hasAccess: false,
    entityType,
    entityId,
    ...clubEntity,
    coverImage: !coverImage
      ? null
      : {
          id: coverImage.id,
          hash: coverImage.hash,
          width: coverImage.width,
          height: coverImage.height,
        },
    description: getHtmlContentPreview({ html: clubEntity.description ?? '', lineClamp: 2 }),
    membership,
    availableInTierIds,
    availability,
  };
};

export const upsertClubEntity = async ({
  clubTierIds,
  privatizeEntity,
  userId,
  isModerator,
  ...data
}: UpsertClubEntityInput & {
  userId: number;
  isModerator?: boolean;
  tx?: Prisma.TransactionClient;
}): Promise<ClubEntityByEntityId | null> => {
  const [club] = await userContributingClubs({ userId: userId, clubId: data.clubId });

  if (!club) {
    throw throwBadRequestError('You do not have permission to add content to this club.');
  }

  const [ownership] = await entityOwnership({
    entityType: data.entityType,
    entityIds: [data.entityId],
    userId,
  });

  if (!ownership?.isOwner) {
    throw throwBadRequestError('You do not have permission to add this entity to a club.');
  }

  const tiers = await getClubTiers({
    clubId: data.clubId,
    userId,
    isModerator,
    joinableOnly: false,
    listedOnly: false,
  });

  const allClubTierIds = tiers.map((t) => t.id);

  const clubEntity = await dbWrite.$transaction(
    async (tx) => {
      const clubEntity = await tx.clubEntity.upsert({
        where: {
          clubId_entityId_entityType: {
            entityId: data.entityId,
            clubId: data.clubId,
            entityType: data.entityType,
          },
        },
        create: {
          ...data,
          addedById: userId,
        },
        update: {
          ...data,
        },
      });

      if (privatizeEntity) {
        await entityAvailabilityUpdate({
          entityType: data.entityType,
          entityIds: [data.entityId],
          availability: Availability.Private,
        });

        if (clubTierIds && clubTierIds.length > 0) {
          // Ensures we have no record of this item beling locked to the clubId
          await tx.entityAccess.deleteMany({
            where: {
              OR: [
                {
                  accessorId: {
                    in: allClubTierIds,
                  },
                  accessorType: 'ClubTier',
                },
                {
                  accessorId: data.clubId,
                  accessorType: 'Club',
                },
              ],
              accessToId: data.entityId,
              accessToType: data.entityType,
            },
          });

          // Link it to all tiers directly.
          await tx.entityAccess.createMany({
            data: clubTierIds.map((clubTierId) => ({
              accessorId: clubTierId,
              accessorType: 'ClubTier',
              accessToId: data.entityId,
              accessToType: data.entityType,
            })),
          });
        } else {
          await tx.entityAccess.deleteMany({
            where: {
              accessorId: {
                in: allClubTierIds,
              },
              accessorType: 'ClubTier',
              accessToId: data.entityId,
              accessToType: data.entityType,
            },
          });

          await tx.entityAccess.create({
            data: {
              accessorId: data.clubId,
              accessorType: 'Club',
              accessToId: data.entityId,
              accessToType: data.entityType,
            },
          });
        }
      } else {
        await tx.entityAccess.deleteMany({
          where: {
            OR: [
              {
                accessorId: {
                  in: allClubTierIds,
                },
                accessorType: 'ClubTier',
              },
              {
                accessorId: data.clubId,
                accessorType: 'Club',
              },
            ],
            accessToId: data.entityId,
            accessToType: data.entityType,
          },
        });

        await entityAvailabilityUpdate({
          entityType: data.entityType,
          entityIds: [data.entityId],
          availability: Availability.Public,
        });
      }

      return clubEntity;
    },
    { maxWait: 10000, timeout: 30000 }
  );

  return getClubEntity({
    clubId: clubEntity.clubId,
    entityId: clubEntity.entityId,
    entityType: clubEntity.entityType as SupportedClubEntities,
    userId,
    isModerator,
    tx: dbWrite, // Ensures we get the latest.
  });
};
