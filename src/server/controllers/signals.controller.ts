import { getTRPCErrorFromUnknown } from '@trpc/server';
import type { Context } from '~/server/context/types';
import { getAccessToken } from '~/server/services/signals.service';

export function getUserAccountHandler({ ctx }: { ctx: DeepNonNullable<Context> }) {
  try {
    return getAccessToken({ id: ctx.user.id });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}
