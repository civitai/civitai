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
  console.error(error);
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

export function handleAuthorizationError(message: string | null = null) {
  message ??= 'You are not authorized to perform this action';
  throw new TRPCError({
    code: 'UNAUTHORIZED',
    message,
  });
}

export function handleBadRequest(message: string | null = null, error?: unknown) {
  message ??= 'Your request is invalid';
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message,
    cause: error,
  });
}
