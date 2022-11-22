import { Prisma } from '@prisma/client';
import { prisma } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';

export const getUserAccounts = <TSelect extends Prisma.AccountSelect = Prisma.AccountSelect>({
  userId,
  select,
}: {
  userId: number;
  select: TSelect;
}) => {
  return prisma.account.findMany({
    where: { userId },
    select,
  });
};

export const deleteAccount = ({ id }: GetByIdInput) => {
  return prisma.account.delete({
    where: { id },
  });
};
