import { PrismaClientKnownRequestError } from '@prisma/client/runtime';
import { TRPCError } from '@trpc/server';
import { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';

export function handleDbError(code: TRPC_ERROR_CODE_KEY, error: unknown) {
  const prismaError = error as PrismaClientKnownRequestError;

  return new TRPCError({
    code,
    message: prismaError.message,
    cause: prismaError.cause,
  });
}
