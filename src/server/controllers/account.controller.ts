import { Context } from '~/server/createContext';
import { GetByIdInput } from '~/server/schema/base.schema';
import { deleteAccount, getUserAccounts } from '~/server/services/account.service';
import { handleDbError } from '~/server/utils/errorHandling';

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
    handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
  }
};

export const deleteAccountHandler = async ({
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: GetByIdInput;
}) => {
  try {
    const deleted = await deleteAccount(input);

    if (!deleted)
      throw handleDbError({
        code: 'NOT_FOUND',
        message: `There is no account with id ${input.id}`,
      });

    return deleted;
  } catch (error) {
    handleDbError({ code: 'INTERNAL_SERVER_ERROR', error });
  }
};
