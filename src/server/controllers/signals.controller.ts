import { getTRPCErrorFromUnknown } from '@trpc/server';
import { Context } from '~/server/createContext';
import { getAccessToken } from '~/server/services/signals.service';

export function getUserAccountHandler({ ctx }: { ctx: DeepNonNullable<Context> }) {
  try {
    return getAccessToken({ id: ctx.user.id });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}
