import { randomBytes } from 'node:crypto';
import type { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { GENERIC_SERVER_ERROR_MESSAGE } from '~/server/utils/rest-error-envelope';

export type ClientSafeError = { message: string; errorRef: string };

// `onError` (via the API route) and `errorFormatter` (via trpc.ts) can resolve DIFFERENT bundled
// copies of this module — see `logging/structured-log-sink.ts` — so the result is stored on the
// error object both receive, under a `Symbol.for` key every copy shares, not in module state.
const CLIENT_SAFE = Symbol.for('civitai.trpc.clientSafeError');

type Stamped = TRPCError & { [CLIENT_SAFE]?: ClientSafeError | null };

/**
 * A server fault's message is never shown to the user: it is replaced with a generic one carrying
 * an `errorRef`, which `onError` writes to Axiom next to the full error. 503 keeps its message —
 * those are always ours ("temporarily unavailable, try again"), same as REST's `isRestServerFault`.
 */
export function getClientSafeError(error: TRPCError): ClientSafeError | undefined {
  const stamped = error as Stamped;
  const cached = stamped[CLIENT_SAFE];
  if (cached !== undefined) return cached ?? undefined;

  const status = getHTTPStatusCodeFromError(error);
  let result: ClientSafeError | null = null;
  if (status >= 500 && status !== 503) {
    const errorRef = randomBytes(6).toString('hex');
    result = { message: `${GENERIC_SERVER_ERROR_MESSAGE} (ref: ${errorRef})`, errorRef };
  }
  try {
    Object.defineProperty(stamped, CLIENT_SAFE, { value: result, enumerable: false });
  } catch {
    // A non-extensible error just gets a fresh ref per call.
  }
  return result ?? undefined;
}
