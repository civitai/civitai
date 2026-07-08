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
  // (ClickUp 868k9gug8).
  //
  // Do it in ONE transaction that first locks the user row: two concurrent disconnects of DIFFERENT providers
  // would otherwise each read count>1 and both delete (a TOCTOU re-opening the exact lockout). A plain
  // check-then-delete can't close it even on the primary — under READ COMMITTED the two txns don't see each
  // other's uncommitted delete of a different row, so both still count a remaining account. `FOR UPDATE` on the
  // User row serializes disconnects for that user; we then delete, re-count inside the lock, and throw (rolling
  // the delete back) if it would leave zero methods and no verified email.
  return dbWrite.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const deleted = await tx.account.delete({ where: { id, userId } });
    const remaining = await tx.account.count({ where: { userId } });
    if (remaining === 0) {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { emailVerified: true },
      });
      if (!user?.emailVerified)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'You cannot disconnect your only login method. Verify an email or connect another account first.',
        });
    }
    return deleted;
  });
};
