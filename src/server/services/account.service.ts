import { Prisma } from '@prisma/client';
import { dbWrite, dbRead } from '~/server/db/client';
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
  });
};

export const deleteAccount = ({ id }: GetByIdInput) => {
  return dbWrite.account.delete({
    where: { id },
  });
};
