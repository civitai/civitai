import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '../db/client';
import { GetByIdInput, InfiniteQueryInput } from '../schema/base.schema';
import { getFilesByEntity } from './file.service';
import { throwNotFoundError } from '../utils/errorHandling';
import { CreateBountyInput, UpdateBountyInput } from '../schema/bounty.schema';
import { imageSelect } from '../selectors/image.selector';
import { groupBy } from 'lodash-es';

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

// TODO.bounty: handle details and tags
export const createBounty = async ({
  files,
  details,
  tags,
  ...data
}: CreateBountyInput & { userId: number }) => {
  const bounty = await dbWrite.$transaction(async (tx) => {
    const bounty = await tx.bounty.create({ data });

    if (files) {
      await tx.file.createMany({
        data: files.map((file) => ({ ...file, entityId: bounty.id, entityType: 'Bounty' })),
      });
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

export const getImagesForBounties = async ({ bountyIds }: { bountyIds: number[] }) => {
  const connections = await dbRead.imageConnection.findMany({
    where: { entityType: 'Bounty', entityId: { in: bountyIds } },
    select: {
      entityId: true,
      image: { select: imageSelect },
    },
  });

  const groupedImages = groupBy(
    connections.map(({ image }) => image),
    'entityId'
  );

  return groupedImages;
};
