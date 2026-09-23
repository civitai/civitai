import { randomBytes } from 'node:crypto';
import type { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { isDriverAuthoredMessage } from '~/server/utils/errorHandling';
import { genericErrorForDriverMessage } from '~/server/utils/rest-error-envelope';

export type ClientSafeError = { message: string; errorRef: string };

// `onError` (via the API route) and `errorFormatter` (via trpc.ts) can resolve DIFFERENT bundled
// copies of this module — see `logging/structured-log-sink.ts` — so the result is stored on the
// error object both receive, under a `Symbol.for` key every copy shares, not in module state.
const CLIENT_SAFE = Symbol.for('civitai.trpc.clientSafeError');

type Stamped = TRPCError & { [CLIENT_SAFE]?: ClientSafeError | null };

/**
 * The replacement for a tRPC error whose message was written by the database driver (Prisma
 * invocation text, Postgres SQLSTATEs, constraint/column names) or a socket error, or `undefined`
 * when the message is ours and safe to show. Same rule as the REST surface's `handleEndpointError`.
 */
export function getClientSafeError(error: TRPCError): ClientSafeError | undefined {
  const stamped = error as Stamped;
  const cached = stamped[CLIENT_SAFE];
  if (cached !== undefined) return cached ?? undefined;

  let result: ClientSafeError | null = null;
  const generic = genericErrorForDriverMessage(getHTTPStatusCodeFromError(error));
  if (generic && isDriverAuthoredMessage(error.message, error)) {
    const errorRef = randomBytes(6).toString('hex');
    result = { message: `${generic.message} (ref: ${errorRef})`, errorRef };
  }
  try {
    Object.defineProperty(stamped, CLIENT_SAFE, { value: result, enumerable: false });
  } catch {
    // A non-extensible error just gets a fresh ref per call.
  }
  return result ?? undefined;
}
