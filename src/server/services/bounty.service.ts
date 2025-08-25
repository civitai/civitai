import { Prisma } from '@prisma/client';
import {
  BountyEntryMode,
  Currency,
  ImageIngestionStatus,
  MetricTimeframe,
  TagTarget,
} from '~/shared/utils/prisma/enums';
import type { ManipulateType } from 'dayjs';
import dayjs from '~/shared/utils/dayjs';
import { groupBy } from 'lodash-es';
import { bountyRefundedEmail } from '~/server/email/templates';
import { TransactionType } from '~/server/schema/buzz.schema';
import { createBuzzTransaction, getUserBuzzAccount } from '~/server/services/buzz.service';
import { createEntityImages, updateEntityImages } from '~/server/services/image.service';
import { decreaseDate, startOfDay } from '~/utils/date-helpers';
import type { NsfwLevel } from '../common/enums';
import { BountySort, BountyStatus } from '../common/enums';
import { dbRead, dbWrite } from '../db/client';
import type { GetByIdInput } from '../schema/base.schema';
import type {
  AddBenefactorUnitAmountInputSchema,
  BountyDetailsSchema,
  CreateBountyInput,
  GetInfiniteBountySchema,
  UpdateBountyInput,
  UpsertBountyInput,
} from '../schema/bounty.schema';
import { createBountyInputSchema, updateBountyInputSchema } from '../schema/bounty.schema';
import { isNotTag, isTag } from '../schema/tag.schema';
import { imageSelect } from '../selectors/image.selector';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwInsufficientFundsError,
  throwNotFoundError,
} from '../utils/errorHandling';
import { updateEntityFiles } from './file.service';
import type { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';
import { userContentOverviewCache } from '~/server/redis/caches';
import { BountyUpsertForm } from '~/components/Bounty/BountyUpsertForm';
import { throwOnBlockedLinkDomain } from '~/server/services/blocklist.service';

export const getAllBounties = <TSelect extends Prisma.BountySelect>({
  input: {
    cursor,
    limit: take,
    query,
    sort,
    types,
    status,
    mode,
    engagement,
    userId,
    period,
    baseModels,
    excludedUserIds,
  },
  select,
}: {
  input: GetInfiniteBountySchema;
  select: TSelect;
}) => {
  const AND: Prisma.Enumerable<Prisma.BountyWhereInput> = [];

  if (userId && engagement) {
    if (engagement === 'favorite')
      AND.push({ engagements: { some: { type: 'Favorite', userId } } });
    if (engagement === 'tracking') AND.push({ engagements: { some: { type: 'Track', userId } } });
    if (engagement === 'supporter') AND.push({ benefactors: { some: { userId } } });
    if (engagement === 'awarded') AND.push({ benefactors: { some: { awartedTo: { userId } } } });
    if (engagement === 'active') AND.push({ entries: { some: { userId } } });
  }

  if (baseModels && baseModels.length) {
    AND.push({
      OR: baseModels.map((base) => ({ details: { path: ['baseModel'], equals: base } })),
    });
  }

  if (status) {
    if (status === BountyStatus.Open)
      AND.push({ complete: false, refunded: false, expiresAt: { gt: new Date() } });
    else if (status === BountyStatus.Awarded)
      AND.push({ complete: true, entries: { some: {} }, refunded: false });
    else if (status === BountyStatus.Expired) {
      // 1. return refunded ones expired
      // 3. return finished (expired) but not completed yet (48hr period).
      // 2. return completed no entries.
      const OR: Prisma.BountyWhereInput[] = [
        { expiresAt: { lt: new Date() }, refunded: true },
        { expiresAt: { lt: new Date() }, complete: false },
        { expiresAt: { lt: new Date() }, entries: { none: {} }, complete: true },
      ];

      AND.push({ OR });
    }
  }

  if (excludedUserIds?.length) {
    AND.push({ userId: { notIn: excludedUserIds } });
  }

  const orderBy: Prisma.BountyFindManyArgs['orderBy'] = [];
  if (sort === BountySort.EndingSoon) orderBy.push({ expiresAt: 'asc' });
  else if (sort === BountySort.HighestBounty)
    orderBy.push({ rank: { [`unitAmountCount${period}Rank`]: 'asc' } });
  else if (sort === BountySort.MostContributors)
    orderBy.push({ rank: { [`entryCount${period}Rank`]: 'asc' } });
  else if (sort === BountySort.MostDiscussed)
    orderBy.push({ rank: { [`commentCount${period}Rank`]: 'asc' } });
  else if (sort === BountySort.MostLiked)
    orderBy.push({ rank: { [`favoriteCount${period}Rank`]: 'asc' } });
  else if (sort === BountySort.MostTracked)
    orderBy.push({ rank: { [`trackCount${period}Rank`]: 'asc' } });
  else if (sort === BountySort.MostEntries)
    orderBy.push({ rank: { [`entryCount${period}Rank`]: 'asc' } });
  else orderBy.push({ createdAt: 'desc' });

  return dbRead.bounty.findMany({
    take,
    cursor: cursor ? { id: cursor } : undefined,
    select,
    where: {
      mode,
      name: query ? { contains: query } : undefined,
      type: types && !!types.length ? { in: types } : undefined,
      createdAt:
        period !== MetricTimeframe.AllTime
          ? { gte: decreaseDate(new Date(), 1, period.toLowerCase() as ManipulateType) }
          : undefined,
      AND,
    },
    orderBy,
  });
};

export const getBountyById = <TSelect extends Prisma.BountySelect>({
  id,
  select,
}: GetByIdInput & { select: TSelect }) => {
  return dbRead.bounty.findUnique({ where: { id }, select });
};

export const createBounty = async ({
  images,
  files,
  ownRights,
  tags,
  unitAmount,
  currency,
  startsAt: incomingStartsAt,
  expiresAt: incomingExpiresAt,
  ...data
}: CreateBountyInput & { userId: number }) => {
  const { userId } = data;
  switch (currency) {
    case Currency.BUZZ:
      const account = await getUserBuzzAccount({ accountId: userId });
      if ((account.balance ?? 0) < unitAmount) {
        throw throwInsufficientFundsError();
      }
      break;
    default: // Do no checks
      break;
  }

  const startsAt = startOfDay(incomingStartsAt, { utc: true });
  const expiresAt = startOfDay(incomingExpiresAt, { utc: true });

  const bounty = await dbWrite.$transaction(
    async (tx) => {
      const bounty = await tx.bounty.create({
        data: {
          ...data,
          startsAt,
          expiresAt,
          // TODO.bounty: Once we support tipping buzz fully, need to re-enable this
          entryMode: BountyEntryMode.BenefactorsOnly,
          details: (data.details as Prisma.JsonObject) ?? Prisma.JsonNull,
          tags: tags
            ? {
                create: tags.map((tag) => {
                  const name = tag.name.toLowerCase().trim();
                  return {
                    tag: {
                      connectOrCreate: {
                        where: { name },
                        create: { name, target: [TagTarget.Bounty] },
                      },
                    },
                  };
                }),
              }
            : undefined,
        },
      });

      await tx.bountyBenefactor.create({
        data: {
          userId,
          bountyId: bounty.id,
          unitAmount,
          currency,
        },
      });

      if (files) {
        await updateEntityFiles({
          tx,
          entityId: bounty.id,
          entityType: 'Bounty',
          files,
          ownRights: !!ownRights,
        });
      }

      if (images) {
        await createEntityImages({
          images,
          tx,
          userId,
          entityId: bounty.id,
          entityType: 'Bounty',
        });
      }

      switch (currency) {
        case Currency.BUZZ:
          await createBuzzTransaction({
            fromAccountId: userId,
            toAccountId: 0,
            amount: unitAmount,
            type: TransactionType.Bounty,
            details: {
              entityId: bounty.id,
              entityType: 'Bounty',
            },
          });
          break;
        default: // Do no checks
          break;
      }

      return bounty;
    },
    { maxWait: 10000, timeout: 30000 }
  );

  if (bounty.userId) {
    await userContentOverviewCache.bust(bounty.userId);
  }

  return { ...bounty, details: bounty.details as BountyDetailsSchema | null };
};

export const updateBountyById = async ({
  id,
  files,
  ownRights,
  tags,
  details,
  startsAt: incomingStartsAt,
  expiresAt: incomingExpiresAt,
  images,
  userId,
  entryLimit,
  ...data
}: UpdateBountyInput & { userId: number }) => {
  // Convert dates to UTC for storing
  const startsAt = startOfDay(incomingStartsAt, { utc: true });
  const expiresAt = startOfDay(incomingExpiresAt, { utc: true });

  const bounty = await dbWrite.$transaction(
    async (tx) => {
      const existing = await tx.bounty.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          entryLimit: true,
          complete: true,
          _count: { select: { entries: true } },
        },
      });

      if (existing.complete) throw throwBadRequestError('Cannot update a completed bounty');

      if (
        entryLimit &&
        existing.entryLimit &&
        entryLimit < existing.entryLimit &&
        existing._count.entries > 0
      ) {
        throw throwBadRequestError(
          'Cannot reduce entry limit because some users already submitted entries.'
        );
      }

      const bounty = await tx.bounty.update({
        where: { id },
        data: {
          ...data,
          entryLimit,
          startsAt,
          expiresAt,
          details: (details as Prisma.JsonObject) ?? Prisma.JsonNull,
          tags: tags
            ? {
                deleteMany: {
                  tagId: {
                    notIn: tags.filter(isTag).map((x) => x.id),
                  },
                },
                connectOrCreate: tags.filter(isTag).map((tag) => ({
                  where: { tagId_bountyId: { tagId: tag.id, bountyId: id } },
                  create: { tagId: tag.id },
                })),
                create: tags.filter(isNotTag).map((tag) => {
                  const name = tag.name.toLowerCase().trim();
                  return {
                    tag: {
                      connectOrCreate: {
                        where: { name },
                        create: { name, target: [TagTarget.Bounty] },
                      },
                    },
                  };
                }),
              }
            : undefined,
        },
      });

      if (!bounty) return null;

      if (files) {
        await updateEntityFiles({
          tx,
          entityId: bounty.id,
          entityType: 'Bounty',
          files,
          ownRights: !!ownRights,
        });
      }

      if (images) {
        await updateEntityImages({
          images,
          tx,
          entityId: bounty.id,
          entityType: 'Bounty',
          userId,
        });
      }

      return bounty;
    },
    { maxWait: 10000, timeout: 30000 }
  );

  if (bounty?.userId) {
    await userContentOverviewCache.bust(bounty?.userId);
  }

  return bounty;
};

export const upsertBounty = async ({
  id,
  userId,
  isModerator,
  ...data
}: UpsertBountyInput & { userId: number; isModerator: boolean }) => {
  await throwOnBlockedLinkDomain(data.description);
  if (id) {
    if (!isModerator) {
      for (const key of data.lockedProperties ?? []) delete data[key as keyof typeof data];
    }

    const updateInput = await updateBountyInputSchema.parseAsync({ id, ...data });
    return updateBountyById({
      ...updateInput,
      userId,
    });
  } else {
    if (data.poi || (data.poi && data.nsfw)) {
      throw throwBadRequestError(
        'The creation of bounties intended to depict an actual person is prohibited.'
      );
    }

    const createInput = await createBountyInputSchema.parseAsync({ ...data });
    return createBounty({ ...createInput, userId });
  }
};

export const deleteBountyById = async ({
  id,
  isModerator,
}: GetByIdInput & { isModerator: boolean }) => {
  const bounty = await getBountyById({
    id,
    select: { userId: true, expiresAt: true, complete: true, refunded: true },
  });

  if (!bounty) throw throwNotFoundError('Bounty not found');

  if (!isModerator) {
    // If only entries created AFTER the cuttoff date are found, we'll allow deletion
    const entryCutOffDate = dayjs.utc(bounty.expiresAt).subtract(6, 'hour').toDate();
    const benefactorsCount = await dbWrite.bountyBenefactor.count({
      where: { bountyId: id, userId: bounty.userId ? { not: bounty.userId } : undefined },
    });
    const entriesCount = await dbWrite.bountyEntry.count({
      where: { bountyId: id, createdAt: { lte: entryCutOffDate } },
    });

    if (benefactorsCount !== 0 || entriesCount !== 0)
      throw throwBadRequestError('Cannot delete bounty because it has supporters and/or entries');
  }

  const deletedBounty = await dbWrite.$transaction(async (tx) => {
    const deletedBounty = await tx.bounty.delete({ where: { id } });
    if (!deletedBounty) return null;

    await tx.file.deleteMany({ where: { entityId: id, entityType: 'Bounty' } });

    return deletedBounty;
  });

  if (!deletedBounty) return null;

  // Refund the bounty creator
  if (bounty.userId && !bounty.complete && !bounty.refunded) {
    const bountyCreator = await dbRead.bountyBenefactor.findUnique({
      where: { bountyId_userId: { userId: bounty.userId, bountyId: id } },
      select: { unitAmount: true, currency: true },
    });

    switch (bountyCreator?.currency) {
      case Currency.BUZZ:
        await createBuzzTransaction({
          fromAccountId: 0,
          toAccountId: bounty.userId,
          amount: bountyCreator.unitAmount,
          type: TransactionType.Refund,
          description: 'Refund reason: owner deleted bounty',
        });
        break;
      default: // Do no checks
        break;
    }
  }

  return deletedBounty;
};

export const getBountyImages = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId?: number; isModerator?: boolean }) => {
  const imageOr: Prisma.Enumerable<Prisma.ImageWhereInput> = isModerator
    ? [{ ingestion: { notIn: [] } }]
    : [{ ingestion: ImageIngestionStatus.Scanned, needsReview: null }];

  if (userId) imageOr.push({ userId });

  const connections = await dbRead.imageConnection.findMany({
    where: {
      entityId: id,
      entityType: 'Bounty',
      image: { OR: imageOr },
    },
    select: { image: { select: imageSelect } },
  });

  return connections.map(({ image }) => ({
    ...image,
    nsfwLevel: image.nsfwLevel as NsfwLevel,
    tags: image.tags.map((t) => t.tag),
  }));
};

export const getBountyFiles = async ({ id }: GetByIdInput) => {
  const files = await dbRead.file.findMany({
    where: { entityId: id, entityType: 'Bounty' },
    select: {
      id: true,
      url: true,
      metadata: true,
      sizeKB: true,
      name: true,
    },
  });

  return files;
};

export const addBenefactorUnitAmount = async ({
  bountyId,
  unitAmount,
  userId,
}: AddBenefactorUnitAmountInputSchema & { userId: number }) => {
  const bounty = await dbRead.bounty.findUnique({
    where: { id: bountyId },
    select: { complete: true },
  });

  if (!bounty) {
    throw throwNotFoundError('Bounty not found');
  }

  if (bounty.complete) {
    throw throwBadRequestError('Bounty is already complete');
  }

  const benefactor = await dbRead.bountyBenefactor.findUnique({
    where: {
      bountyId_userId: {
        userId,
        bountyId,
      },
    },
    select: {
      unitAmount: true,
      currency: true,
    },
  });

  const { currency } = benefactor || { currency: Currency.BUZZ };

  switch (currency) {
    case Currency.BUZZ:
      const account = await getUserBuzzAccount({ accountId: userId });
      if ((account.balance ?? 0) < unitAmount) {
        throw throwInsufficientFundsError();
      }
      break;
    default: // Do no checks
      break;
  }

  switch (currency) {
    case Currency.BUZZ:
      await createBuzzTransaction({
        fromAccountId: userId,
        toAccountId: 0,
        amount: unitAmount,
        type: TransactionType.Bounty,
        description: 'You have supported a bounty',
        details: {
          entityId: bountyId,
          entityType: 'Bounty',
        },
      });
      break;
    default: // Do no checks
      break;
  }

  // Update benefactor record;
  const updatedBenefactor = await dbWrite.bountyBenefactor.upsert({
    update: {
      unitAmount: unitAmount + (benefactor?.unitAmount ?? 0),
    },
    create: {
      userId,
      bountyId,
      unitAmount,
    },
    where: {
      bountyId_userId: {
        userId,
        bountyId,
      },
    },
  });

  return updatedBenefactor;
};

export const getImagesForBounties = async ({
  bountyIds,
  userId,
  isModerator,
}: {
  bountyIds: number[];
  userId?: number;
  isModerator?: boolean;
}) => {
  const imageOr: Prisma.Enumerable<Prisma.ImageWhereInput> = isModerator
    ? [{ ingestion: { notIn: [] } }]
    : [{ ingestion: ImageIngestionStatus.Scanned, needsReview: null }];
  if (userId) imageOr.push({ userId });

  const connections = await dbRead.imageConnection.findMany({
    where: {
      entityType: 'Bounty',
      entityId: { in: bountyIds },
      image: { OR: imageOr },
    },
    select: {
      entityId: true,
      image: { select: imageSelect },
    },
  });

  const groupedImages = groupBy(
    connections.map(({ entityId, image }) => ({
      ...image,
      nsfwLefel: image.nsfwLevel as NsfwLevel,
      tags: image.tags.map((t) => ({ id: t.tag.id, name: t.tag.name })),
      entityId,
      metadata: image.metadata as ImageMetadata | VideoMetadata | null,
    })),
    'entityId'
  );

  return groupedImages;
};

export const refundBounty = async ({
  id,
  isModerator,
}: GetByIdInput & { isModerator: boolean }) => {
  if (!isModerator) {
    throw throwAuthorizationError();
  }

  const bounty = await dbRead.bounty.findUniqueOrThrow({
    where: { id },
    select: {
      name: true,
      id: true,
      complete: true,
      refunded: true,
      userId: true,
      user: { select: { id: true, email: true } },
    },
  });

  const { user } = bounty;

  if (bounty.complete || bounty.refunded) {
    throw throwBadRequestError('This bounty has already been awarded or refunded');
  }

  const benefactors = await dbRead.bountyBenefactor.findMany({
    where: { bountyId: id },
  });

  if (benefactors.find((b) => b.awardedToId !== null)) {
    throw throwBadRequestError(
      'At least one benefactor has awarded an entry. This bounty is not refundable.'
    );
  }

  const currency = benefactors.find((b) => b.userId === bounty.userId)?.currency;

  if (!currency) {
    throw throwBadRequestError('No currency found for bounty');
  }

  for (const { userId, unitAmount } of benefactors) {
    if (unitAmount > 0) {
      switch (currency) {
        case Currency.BUZZ:
          await createBuzzTransaction({
            fromAccountId: 0,
            toAccountId: userId,
            amount: unitAmount,
            type: TransactionType.Refund,
            description: 'Reason: Bounty refund',
          });

          break;
        default: // Do nothing just yet.
          break;
      }
    }
  }

  if (user) {
    bountyRefundedEmail.send({
      bounty,
      user,
    });
  }

  const updated = await dbWrite.bounty.update({
    where: { id },
    data: { complete: true, refunded: true },
  });

  if (updated.userId) {
    await userContentOverviewCache.bust(updated.userId);
  }

  return updated;
};
