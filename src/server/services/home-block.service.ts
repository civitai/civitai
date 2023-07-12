import { dbRead } from '~/server/db/client';
import { Prisma } from '@prisma/client';

export const getHomeBlocks = <TSelect extends Prisma.HomeBlockSelect = Prisma.HomeBlockSelect>({
  select,
}: {
  select: TSelect;
}) => {
  return dbRead.homeBlock.findMany({
    select,
    orderBy: { index: 'asc' },
  });
};
