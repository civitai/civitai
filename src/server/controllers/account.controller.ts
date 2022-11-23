import { Context } from '~/server/createContext';
import { GetByIdInput } from '~/server/schema/base.schema';
import { deleteAccount, getUserAccounts } from '~/server/services/account.service';
import { throwDbError } from '~/server/utils/errorHandling';

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
    throw throwDbError(error);
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

    if (!deleted) throw throwDbError();

    return deleted;
  } catch (error) {
    throw throwDbError(error);
  }
};
