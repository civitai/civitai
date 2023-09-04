import { Currency, Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '../db/client';
import { GetByIdInput, InfiniteQueryInput } from '../schema/base.schema';
import { getFilesByEntity } from './file.service';
import { throwInsufficientFundsError, throwNotFoundError } from '../utils/errorHandling';
import { CreateBountyInput, UpdateBountyInput } from '../schema/bounty.schema';
import { imageSelect } from '../selectors/image.selector';
import { getUserAccountHandler } from '~/server/controllers/buzz.controller';
import { createBuzzTransaction, getUserBuzzAccount } from '~/server/services/buzz.service';
import { TransactionType } from '~/server/schema/buzz.schema';

export const getAllBounties = <TSelect extends Prisma.BountySelect>({
  input: { cursor, limit: take },
  select,
}: {
  input: InfiniteQueryInput;
  select: TSelect;
}) => {
  return dbRead.bounty.findMany({
    take,
    cursor: cursor ? { id: cursor } : undefined,
    select,
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

// TODO.bounty: tags
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
      console.log(account.balance, unitAmount);
      if (account.balance < unitAmount) {
        throw throwInsufficientFundsError();
      }
      break;
    default: // Do no checks
      break;
  }

  const bounty = await dbWrite.$transaction(async (tx) => {
    const bounty = await tx.bounty.create({ data });

    await tx.bountyBenefactor.create({
      data: {
        userId,
        bountyId: bounty.id,
        unitAmount,
        currency,
      },
    });

    if (files) {
      await tx.file.createMany({
        data: files.map((file) => ({ ...file, entityId: bounty.id, entityType: 'Bounty' })),
      });
    }

    if (images) {
      await tx.image.createMany({
        data: images.map((image) => ({
          ...image,
          meta: (image?.meta as Prisma.JsonObject) ?? Prisma.JsonNull,
          userId,
          resources: undefined,
        })),
      });

      const imageIds = await tx.image.findMany({
        select: { id: true },
        where: {
          url: {
            in: images.map((i) => i.url),
          },
          userId,
        },
      });

      await tx.imageConnection.createMany({
        data: imageIds.map((image) => ({
          imageId: image.id,
          entityId: bounty.id,
          entityType: 'Bounty',
        })),
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

// TODO.bounty: handle details and tags
export const updateBountyById = async ({
  id,
  files,
  details,
  tags,
  ...data
}: UpdateBountyInput) => {
  const bounty = await dbWrite.$transaction(async (tx) => {
    const bounty = await tx.bounty.update({ where: { id }, data });
    if (!bounty) return null;

    if (files) {
      await tx.file.deleteMany({ where: { entityId: id, entityType: 'Bounty' } });
      await tx.file.createMany({
        data: files.map((file) => ({ ...file, entityId: bounty.id, entityType: 'Bounty' })),
      });
    }

    return bounty;
  });

  return bounty;
};

export const deleteBountyById = async ({ id }: GetByIdInput) => {
  const bounty = await dbWrite.$transaction(async (tx) => {
    const deletedBounty = await tx.bounty.delete({ where: { id } });
    if (!deletedBounty) return null;

    await tx.file.deleteMany({ where: { entityId: id, entityType: 'Bounty' } });

    return deletedBounty;
  });

  return bounty;
};

export const getBountyImages = async ({ id }: GetByIdInput) => {
  const connections = await dbRead.imageConnection.findMany({
    where: { entityId: id, entityType: 'Bounty' },
    select: { image: { select: imageSelect } },
  });

  return connections.map(({ image }) => image);
};
