import { dbWrite, dbRead } from '~/server/db/client';
import { UpsertClubInput, UpsetClubTiersInput } from '~/server/schema/club.schema';
import { BountyDetailsSchema, CreateBountyInput } from '~/server/schema/bounty.schema';
import { BountyEntryMode, Currency, Prisma, TagTarget } from '@prisma/client';
import { createBuzzTransaction, getUserBuzzAccount } from '~/server/services/buzz.service';
import { throwBadRequestError, throwInsufficientFundsError } from '~/server/utils/errorHandling';
import { startOfDay, toUtc } from '~/utils/date-helpers';
import { updateEntityFiles } from '~/server/services/file.service';
import { createEntityImages } from '~/server/services/image.service';
import { TransactionType } from '~/server/schema/buzz.schema';
import { ImageMetaProps, ImageUploadProps } from '~/server/schema/image.schema';
import { isDefined } from '~/utils/type-guards';
import { GetByIdInput } from '~/server/schema/base.schema';
import { imageSelect } from '~/server/selectors/image.selector';

export const getClub = async ({
  id,
}: GetByIdInput & { userId?: number; isModerator?: boolean }) => {
  const club = await dbRead.club.findUniqueOrThrow({
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
}: UpsertClubInput & { userId: number; isModerator: boolean }) {
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
}: Omit<UpsertClubInput, 'tiers' | 'deleteTierIds'> & { id: number; userId: number }) => {
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
}: Omit<UpsertClubInput, 'id'> & { userId: number }) => {
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

const upsertClubTiers = async ({
  clubId,
  tiers,
  deleteTierIds,
  tx,
  userId,
}: {
  userId: number;
  clubId: number;
  deleteTierIds: number[];
  tiers: UpsetClubTiersInput[];
  tx?: Prisma.TransactionClient;
}) => {
  const dbClient = tx ?? dbWrite;

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
      data: toCreate.map((tier) => ({
        ...tier,
        clubId,
        coverImageId:
          tier.coverImage?.id ?? createdImages.find((i) => i.url === tier.coverImage?.url)?.id,
      })),
      skipDuplicates: true,
    });
  }

  const toUpdate = tiers.filter((tier) => tier.id !== undefined);
  if (toUpdate.length > 0) {
    await dbClient.clubTier.updateMany({
      where: {
        id: {
          in: toUpdate.map((tier) => tier.id as number),
        },
      },
      data: toUpdate.map(({ coverImage, ...tier }) => ({
        ...tier,
        coverImageId:
          coverImage === null
            ? null
            : coverImage === undefined
            ? undefined
            : coverImage?.id ?? createdImages.find((i) => i.url === coverImage?.url)?.id,
        clubId,
      })),
    });
  }
};
