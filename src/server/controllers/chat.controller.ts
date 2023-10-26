import { getTRPCErrorFromUnknown } from '@trpc/server';
import { Context } from '~/server/createContext';
import { ChatGetAllSchema } from '~/server/schema/chat.schema';
import { getUserBuzzAccount } from '~/server/services/buzz.service';

export function getAllChatsHandler({
  ctx,
  input,
}: {
  ctx: DeepNonNullable<Context>;
  input: ChatGetAllSchema;
}) {
  try {
    return getUserBuzzAccount({ accountId: ctx.user.id });
  } catch (error) {
    throw getTRPCErrorFromUnknown(error);
  }
}
