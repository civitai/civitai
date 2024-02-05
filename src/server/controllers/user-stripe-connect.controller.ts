import { TRPCError } from '@trpc/server';
import { Context } from '~/server/createContext';
import { throwDbError } from '../utils/errorHandling';
import { getUserStripeConnectAccount } from '../services/user-stripe-connect.service';

export const getHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  const userId = ctx.user.id;
  try {
    return getUserStripeConnectAccount({ userId });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
