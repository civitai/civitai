// Connection-level failure codes worth one retry on a fresh connection. The dominant one is the
// keep-alive race: a pooled idle socket that the server has already closed gets reused, and the
// request fails as `read ECONNRESET` or undici's `other side closed` (UND_ERR_SOCKET).
// ECONNREFUSED means the connection was never made, so nothing was sent.
// An HTTP error response and a timeout carry none of these codes, so neither is retried.
const TRANSIENT_CONNECTION_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'UND_ERR_SOCKET']);

/** fetch rejects with TypeError('fetch failed') whose `cause` is the socket error. */
export function isTransientConnectionError(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown } } | null | undefined)?.cause?.code;
  return typeof code === 'string' && TRANSIENT_CONNECTION_CODES.has(code);
}

/**
 * Runs `call`, and runs it once more if it failed with a transient connection error. Only for
 * idempotent calls: a reset socket does not tell whether the server received the request.
 */
export async function retryOnceOnConnectionError<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!isTransientConnectionError(error)) throw error;
    return call();
  }
}
