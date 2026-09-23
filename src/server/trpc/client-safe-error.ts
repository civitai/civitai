import { randomBytes } from 'node:crypto';
import type { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { isDriverAuthoredMessage } from '~/server/utils/errorHandling';
import { genericErrorForDriverMessage } from '~/server/utils/rest-error-envelope';

export type ClientSafeError = { message: string; errorRef: string };

// tRPC hands the same error object to `onError` and then to `errorFormatter`, so keying on it lets
// the log line and the response carry one ref without either knowing the other's call order.
const masked = new WeakMap<TRPCError, ClientSafeError | null>();

/**
 * The replacement for a tRPC error whose message was written by the database driver (Prisma
 * invocation text, Postgres SQLSTATEs, constraint/column names) or a socket error, or `undefined`
 * when the message is ours and safe to show. Same rule as the REST surface's `handleEndpointError`.
 */
export function getClientSafeError(error: TRPCError): ClientSafeError | undefined {
  const cached = masked.get(error);
  if (cached !== undefined) return cached ?? undefined;

  let result: ClientSafeError | null = null;
  const generic = genericErrorForDriverMessage(getHTTPStatusCodeFromError(error));
  if (generic && isDriverAuthoredMessage(error.message, error)) {
    const errorRef = randomBytes(6).toString('hex');
    result = { message: `${generic.message} (ref: ${errorRef})`, errorRef };
  }
  masked.set(error, result);
  return result ?? undefined;
}
