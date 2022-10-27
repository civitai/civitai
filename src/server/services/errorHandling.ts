import { Prisma } from '@prisma/client';
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
  let errorMessage = message ?? 'Invalid database operation';

  if (error instanceof Prisma.PrismaClientKnownRequestError) errorMessage = error.message;
  else if (error instanceof Prisma.PrismaClientValidationError)
    errorMessage = 'Database validation error';

  throw new TRPCError({
    code,
    message: errorMessage,
    cause: error,
  });
}
