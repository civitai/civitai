import { dbWrite, dbRead } from '~/server/db/client';
import { UpsertClubInput, UpsetClubTiersInput } from '~/server/schema/club.schema';
import { BountyDetailsSchema, CreateBountyInput } from '~/server/schema/bounty.schema';
import { BountyEntryMode, Currency, Prisma, TagTarget } from '@prisma/client';
import { createBuzzTransaction, getUserBuzzAccount } from '~/server/services/buzz.service';
import { throwInsufficientFundsError } from '~/server/utils/errorHandling';
import { startOfDay, toUtc } from '~/utils/date-helpers';
import { updateEntityFiles } from '~/server/services/file.service';
import { createEntityImages } from '~/server/services/image.service';
import { TransactionType } from '~/server/schema/buzz.schema';
import { ImageUploadProps } from '~/server/schema/image.schema';
import { isDefined } from '~/utils/type-guards';

export function upsertClub({
  isModerator,
  userId,
  id,
  ...input
}: UpsertClubInput & { userId: number; isModerator: boolean }) {
  if (id) {
    // TODO: Update club
  } else {
    return createClub({ ...input, userId });
  }
}

export const createClub = async ({
  coverImage,
  headerImage,
  avatarImage,
  tiers = [],
  deleteTierIds = [],
  ...data
}: Omit<UpsertClubInput, 'id'> & { userId: number }) => {
  const { userId } = data;

  const club = await dbWrite.$transaction(
    async (tx) => {
      const club = await tx.club.create({
        data: {
          ...data,
          avatar: {
            connectOrCreate: {
              where: { id: avatarImage.id ?? -1 },
              create: {
                ...avatarImage,
                meta: (avatarImage?.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
                userId,
                resources: undefined,
              },
            },
          },
          headerImage: {
            connectOrCreate: {
              where: { id: headerImage.id ?? -1 },
              create: {
                ...headerImage,
                meta: (headerImage?.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
                userId,
                resources: undefined,
              },
            },
          },
          coverImage: {
            connectOrCreate: {
              where: { id: coverImage.id ?? -1 },
              create: {
                ...coverImage,
                meta: (coverImage?.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
                userId,
                resources: undefined,
              },
            },
          },
        },
      });

      // Create tiers:
      await upsertClubTiers({
        clubId: club.id,
        tiers,
        deleteTierIds,
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
}: {
  clubId: number;
  deleteTierIds: number[];
  tiers: UpsetClubTiersInput[];
  tx?: Prisma.TransactionClient;
}) => {
  const dbClient = tx ?? dbWrite;

  const toCreate = tiers.filter((tier) => !tier.id);
  if (toCreate.length > 0) {
    await dbClient.clubTier.createMany({
      data: toCreate.map((tier) => ({
        ...tier,
        clubId,
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
      data: toUpdate.map((tier) => ({
        ...tier,
        clubId,
      })),
    });
  }

  if ((deleteTierIds?.length ?? 0) > 0) {
    await dbClient.clubTier.deleteMany({
      where: {
        id: {
          in: deleteTierIds,
        },
      },
    });
  }
};
