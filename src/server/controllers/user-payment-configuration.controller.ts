import { TRPCError } from '@trpc/server';
import type { Context } from '~/server/createContext';
import { throwDbError } from '../utils/errorHandling';
import { getUserPaymentConfiguration } from '../services/user-payment-configuration.service';

export const getHandler = async ({ ctx }: { ctx: DeepNonNullable<Context> }) => {
  const userId = ctx.user.id;
  try {
    const userPaymentConfig = await getUserPaymentConfiguration({ userId });
    if (!userPaymentConfig) return null;

    return userPaymentConfig;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};
