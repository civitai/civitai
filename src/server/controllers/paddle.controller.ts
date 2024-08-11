import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { Context } from '~/server/createContext';
import { createTransaction } from '~/server/services/paddle.service';
import { TransactionCreateInput } from '~/server/schema/paddle.schema';
import { getTRPCErrorFromUnknown } from '@trpc/server';

export const createTransactionHandler = async ({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: TransactionCreateInput;
}) => {
  try {
    if (!ctx.user.email) {
      throw throwAuthorizationError('Email is required to create a transaction');
    }

    const user = { id: ctx.user.id, email: ctx.user.email as string };
    return await createTransaction({ user, ...input });
  } catch (e) {
    throw getTRPCErrorFromUnknown(e);
  }
};
