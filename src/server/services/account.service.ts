import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';

export const getUserAccounts = <TSelect extends Prisma.AccountSelect = Prisma.AccountSelect>({
  userId,
  select,
}: {
  userId: number;
  select: TSelect;
}) => {
  return dbRead.account.findMany({
    where: { userId },
    select,
    orderBy: { id: 'asc' },
  });
};

export const deleteAccount = ({ id, userId }: GetByIdInput & { userId: number }) => {
  return dbWrite.account.delete({
    where: { id, userId },
  });
};
