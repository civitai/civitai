import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import type { GetByIdInput } from '~/server/schema/base.schema';

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

export const deleteAccount = async ({ id, userId }: GetByIdInput & { userId: number }) => {
  // Never let a user strip their LAST login method: an OAuth account may be disconnected only if another account
  // remains OR a verified email (the magic-link fallback) exists. Without this, disconnecting the sole provider on
  // an email-less/unverified user permanently locks them out — the client guard in AccountsCard was the only check
  // (ClickUp 868k9gug8). Count on the primary so a read-replica lag can't let two concurrent deletes both pass.
  const [accountCount, user] = await Promise.all([
    dbWrite.account.count({ where: { userId } }),
    dbWrite.user.findUnique({ where: { id: userId }, select: { emailVerified: true } }),
  ]);
  if (accountCount <= 1 && !user?.emailVerified)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'You cannot disconnect your only login method. Verify an email or connect another account first.',
    });

  return dbWrite.account.delete({
    where: { id, userId },
  });
};
