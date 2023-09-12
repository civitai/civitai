import { Currency, ImageIngestionStatus, Prisma, TagTarget } from '@prisma/client';
import { dbRead, dbWrite } from '../db/client';
import { GetByIdInput } from '../schema/base.schema';
import { getFilesByEntity, updateEntityFiles } from './file.service';
import {
  throwBadRequestError,
  throwInsufficientFundsError,
  throwNotFoundError,
} from '../utils/errorHandling';
import {
  AddBenefactorUnitAmountInputSchema,
  CreateBountyInput,
  GetInfiniteBountySchema,
  UpdateBountyInput,
} from '../schema/bounty.schema';
import { imageSelect } from '../selectors/image.selector';
import { getUserAccountHandler } from '~/server/controllers/buzz.controller';
import { createBuzzTransaction, getUserBuzzAccount } from '~/server/services/buzz.service';
import { TransactionType } from '~/server/schema/buzz.schema';
import { createEntityImages, ingestImage } from '~/server/services/image.service';
import { chunk, groupBy } from 'lodash-es';
import { BountySort, BountyStatus } from '../common/enums';
import { isNotTag, isTag } from '../schema/tag.schema';

export const getAllBounties = <TSelect extends Prisma.BountySelect>({
  input: { cursor, limit: take, query, sort, types, status, mode },
  select,
}: {
  input: GetInfiniteBountySchema;
  select: TSelect;
}) => {
  const orderBy: Prisma.BountyFindManyArgs['orderBy'] = [];
  // TODO.bounty: handle sorting when metrics are in
  if (sort === BountySort.EndingSoon) orderBy.push({ expiresAt: 'asc' });
  else orderBy.push({ createdAt: 'desc' });

  return dbRead.bounty.findMany({
    take,
    cursor: cursor ? { id: cursor } : undefined,
    select,
    where: {
      mode,
      name: query ? { contains: query } : undefined,
      type: types && !!types.length ? { in: types } : undefined,
      expiresAt:
        status === BountyStatus.Open
          ? { gt: new Date() }
          : status === BountyStatus.Expired
          ? { lt: new Date() }
          : undefined,
    },
    orderBy,
  });
};

export const getBountyById = async <TSelect extends Prisma.BountySelect>({
  id,
  select,
}: GetByIdInput & { select: TSelect }) => {
  const bounty = await dbRead.bounty.findUnique({ where: { id }, select });
  if (!bounty) throw throwNotFoundError(`No bounty with id ${id}`);

  const files = await getFilesByEntity({ id: bounty.id, type: 'Bounty' });

  return { ...bounty, files };
};

export const createBounty = async ({
  images,
  files,
  tags,
  unitAmount,
  currency,
  ...data
}: CreateBountyInput & { userId: number }) => {
  const { userId } = data;
  switch (currency) {
    case Currency.BUZZ:
      const account = await getUserBuzzAccount({ accountId: userId });
      if (account.balance < unitAmount) {
        throw throwInsufficientFundsError();
      }
      break;
    default: // Do no checks
      break;
  }

  const bounty = await dbWrite.$transaction(async (tx) => {
    const bounty = await tx.bounty.create({
      data: {
        ...data,
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
      await updateEntityFiles({ tx, entityId: bounty.id, entityType: 'Bounty', files });
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
        });
        break;
      default: // Do no checks
        break;
    }

    return bounty;
  });

  return bounty;
};

export const updateBountyById = async ({ id, files, tags, ...data }: UpdateBountyInput) => {
  const bounty = await dbWrite.$transaction(async (tx) => {
    const bounty = await tx.bounty.update({
      where: { id },
      data: {
        ...data,
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
      await updateEntityFiles({ tx, entityId: bounty.id, entityType: 'Bounty', files });
    }

    return bounty;
  });

  return bounty;
};

export const deleteBountyById = async ({ id }: GetByIdInput) => {
  const bounty = await getBountyById({ id, select: { userId: true } });
  if (!bounty) throw throwNotFoundError('Bounty not found');

  const benefactorsCount = await dbWrite.bountyBenefactor.count({
    where: { bountyId: id, userId: bounty.userId ? { not: bounty.userId } : undefined },
  });
  const entriesCount = await dbWrite.bountyEntry.count({ where: { bountyId: id } });

  if (benefactorsCount !== 0 || entriesCount !== 0)
    throw throwBadRequestError('Cannot delete bounty because it has benefactors and/or entries');

  const deletedBounty = await dbWrite.$transaction(async (tx) => {
    const deletedBounty = await tx.bounty.delete({ where: { id } });
    if (!deletedBounty) return null;

    await tx.file.deleteMany({ where: { entityId: id, entityType: 'Bounty' } });

    return deletedBounty;
  });
  if (!deletedBounty) return null;

  // Refund the bounty creator
  if (bounty.userId) {
    const bountyCreator = await dbRead.bountyBenefactor.findUnique({
      where: { userId_bountyId: { userId: bounty.userId, bountyId: id } },
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

export const getBountyImages = async ({ id }: GetByIdInput) => {
  const connections = await dbRead.imageConnection.findMany({
    where: { entityId: id, entityType: 'Bounty' },
    select: { image: { select: imageSelect } },
  });

  return connections.map(({ image }) => image);
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
      userId_bountyId: {
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
      if (account.balance < unitAmount) {
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
      userId_bountyId: {
        userId,
        bountyId,
      },
    },
  });

  return updatedBenefactor;
};

export const getImagesForBounties = async ({ bountyIds }: { bountyIds: number[] }) => {
  // TODO.bounty: correctly handle image ingestion
  const connections = await dbRead.imageConnection.findMany({
    where: { entityType: 'Bounty', entityId: { in: bountyIds }, image: { ingestion: 'Pending' } },
    select: {
      entityId: true,
      image: { select: imageSelect },
    },
  });

  const groupedImages = groupBy(
    connections.map(({ entityId, image }) => ({ ...image, entityId })),
    'entityId'
  );

  return groupedImages;
};
