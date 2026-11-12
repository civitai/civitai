import type { ServerResponse } from 'node:http';
import { isDbUnavailableError } from '@civitai/db/db-errors';
import { isUpstreamNetworkError } from '~/server/utils/errorHandling';

/**
 * Page lookups in `getServerSideProps`: only a CONFIRMED missing row may become `notFound`. Anything
 * else (the database or another dependency failing) must not tell the user, a crawler or a cache that
 * the page does not exist — it is rethrown so Next renders its error page, with `no-store`, and as a
 * 503 + `Retry-After` when the failure is a dependency being unavailable.
 */

/** `code` at the top level is a server-side `TRPCError`; `data.code` is a `TRPCClientError`. */
export function isNotFoundError(error: unknown): boolean {
  const err = error as { code?: string; data?: { code?: string } } | null | undefined;
  return err?.code === 'NOT_FOUND' || err?.data?.code === 'NOT_FOUND';
}

const UNAVAILABLE_TRPC_CODES = new Set(['SERVICE_UNAVAILABLE', 'TIMEOUT']);

/** A dependency failed to answer, as opposed to a bug in the page. */
export function isDependencyUnavailableError(error: unknown): boolean {
  const err = error as { code?: string; data?: { code?: string } } | null | undefined;
  if (
    UNAVAILABLE_TRPC_CODES.has(err?.code ?? '') ||
    UNAVAILABLE_TRPC_CODES.has(err?.data?.code ?? '')
  )
    return true;
  return isDbUnavailableError(error) || isUpstreamNetworkError(error);
}

export const DEPENDENCY_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

/** Thrown from `getServerSideProps`; `_error` turns its `statusCode` into the response status. */
export class DependencyUnavailableError extends Error {
  readonly statusCode = 503;
  constructor(cause: unknown) {
    super('A dependency of this page is temporarily unavailable', { cause });
    this.name = 'DependencyUnavailableError';
  }
}

/** Rethrow a page-lookup failure that is not a confirmed miss: never cacheable, 503 when transient. */
export function rethrowSsrError(res: Pick<ServerResponse, 'setHeader'>, error: unknown): never {
  res.setHeader('Cache-Control', 'no-store');
  if (isDependencyUnavailableError(error)) {
    res.setHeader('Retry-After', String(DEPENDENCY_UNAVAILABLE_RETRY_AFTER_SECONDS));
    throw new DependencyUnavailableError(error);
  }
  throw error;
}

/** A `.catch` handler: `null` for a confirmed miss, {@link rethrowSsrError} for anything else. */
export const nullIfNotFound =
  (res: Pick<ServerResponse, 'setHeader'>) =>
  (error: unknown): null => {
    if (isNotFoundError(error)) return null;
    return rethrowSsrError(res, error);
  };
