import { PrismaClientKnownRequestError } from '@prisma/client/runtime';
import { TRPCError } from '@trpc/server';
import { TRPC_ERROR_CODE_KEY } from '@trpc/server/rpc';

export function handleDbError({
  code,
  error,
  message,
}: {
  code: TRPC_ERROR_CODE_KEY;
  error?: unknown;
  message?: string;
}) {
  const prismaError = error as PrismaClientKnownRequestError;

  throw new TRPCError({
    code,
    message: message ?? prismaError.message,
    cause: prismaError,
  });
}
