import { randomBytes } from 'node:crypto';
import type { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { isDriverAuthoredMessage } from '~/server/utils/errorHandling';
import {
  GENERIC_CLIENT_ERROR_BY_STATUS,
  GENERIC_SERVER_ERROR_MESSAGE,
} from '~/server/utils/rest-error-envelope';

export type ClientSafeError = { message: string; errorRef: string };

// tRPC hands the same error object to `onError` and then to `errorFormatter`, so keying on it lets
// the log line and the response carry one ref without either knowing the other's call order.
const masked = new WeakMap<TRPCError, ClientSafeError | null>();

/**
 * The replacement for a tRPC error whose message was written by the database driver (Prisma
 * invocation text, Postgres SQLSTATEs, constraint/column names), or `undefined` when the message
 * is ours and safe to show. Same predicate as the REST surface's `handleEndpointError`.
 */
export function getClientSafeError(error: TRPCError): ClientSafeError | undefined {
  const cached = masked.get(error);
  if (cached !== undefined) return cached ?? undefined;

  let result: ClientSafeError | null = null;
  if (isDriverAuthoredMessage(error.message, error)) {
    const status = getHTTPStatusCodeFromError(error);
    const generic =
      GENERIC_CLIENT_ERROR_BY_STATUS[status]?.message ??
      `${GENERIC_SERVER_ERROR_MESSAGE}, please try again`;
    const errorRef = randomBytes(6).toString('hex');
    result = { message: `${generic} (ref: ${errorRef})`, errorRef };
  }
  masked.set(error, result);
  return result ?? undefined;
}
