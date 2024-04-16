import { TRPCError } from '@trpc/server';
import { Context } from '~/server/createContext';
import { GetByIdInput } from '~/server/schema/base.schema';
import { deleteAccount, getUserAccounts } from '~/server/services/account.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';

export const getUserAccountsHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  const { user } = ctx;

  try {
    return await getUserAccounts({
      userId: user.id,
      select: {
        id: true,
        provider: true,
      },
    });
  } catch (error) {
    throwDbError(error);
  }
};

export const deleteAccountHandler = async ({
  input,
  ctx,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetByIdInput;
}) => {
  try {
    const deleted = await deleteAccount({ ...input, userId: ctx.user.id });

    if (!deleted) throw throwNotFoundError(`No account with id ${input.id}`);

    return deleted;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
};
