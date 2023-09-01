import { Prisma } from '@prisma/client';
import { GetByIdInput } from '../schema/base.schema';
import { dbRead } from '../db/client';

export const getEntryById = <TSelect extends Prisma.BountyEntrySelect>({
  input,
  select,
}: {
  input: GetByIdInput;
  select: TSelect;
}) => {
  return dbRead.bountyEntry.findUnique({ where: { id: input.id }, select });
};

export const getAllEntriesByBountyId = <TSelect extends Prisma.BountyEntrySelect>({
  input,
  select,
}: {
  input: { bountyId: number };
  select: TSelect;
}) => {
  return dbRead.bountyEntry.findMany({
    where: { bountyId: input.bountyId },
    select,
  });
};
