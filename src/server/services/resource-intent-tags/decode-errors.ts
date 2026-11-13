/**
 * The decoder itself was unavailable (a decode worker that did not start or ended without
 * answering). Says nothing about the payload, so it is never taken for bad bytes. Its own module so
 * the worker-side decoder does not load the store.
 */
export class TagIndexDecodeUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(cause instanceof Error ? `${message}: ${cause.message}` : message, { cause });
  }
}
