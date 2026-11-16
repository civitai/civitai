// Retry a Prisma read once when it failed only because its pooled connection had already been closed
// by the other side (a connection pooler or server restart closes every client connection it holds).
// The query engine hands out such a connection as if it were alive, and the first query on it fails;
// the engine then discards it, so a second attempt runs on a different connection.
import { Prisma } from '@civitai/db-schema';

/**
 * Model operations that only read, so running one twice returns the same thing as running it once.
 * Writes are never retried: a write that failed with a closed connection may still have committed.
 */
export const RETRYABLE_READ_OPERATIONS = [
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
] as const;

const RETRYABLE_READS: ReadonlySet<string> = new Set(RETRYABLE_READ_OPERATIONS);

// Matched by name and fields rather than `instanceof`: the app evaluates the Prisma runtime once per
// bundler module graph, so an error can come from a class this module never imported.
const CLOSED_CONNECTION_MESSAGE = /server has closed the connection|error \{ kind: closed\b/i;

/**
 * True for the errors a read on an already-closed connection fails with: P1017 ("Server has closed
 * the connection."), or the same condition surfaced without a code ("Error { kind: Closed, … }").
 *
 * Deliberately not matched: a session-ending message that races the query (SQLSTATE 57P01
 * "terminating connection due to administrator command", a pooler's "server shutting down"). The
 * engine does not discard the connection on that error, so a single retry lands on the same
 * connection and fails with P1017; retrying it would only add a failed round trip.
 */
export function isClosedConnectionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
  if (name === 'PrismaClientKnownRequestError' && code === 'P1017') return true;
  if (name !== 'PrismaClientKnownRequestError' && name !== 'PrismaClientUnknownRequestError')
    return false;
  return typeof message === 'string' && CLOSED_CONNECTION_MESSAGE.test(message);
}

export type ConnectionRetryEvent = {
  model: string | undefined;
  operation: string;
  /** The first attempt's error. */
  error: unknown;
  /** How the single retry ended. */
  result: 'ok' | 'failed';
};

export type ConnectionRetryOptions = {
  /** Called once per retried query, after the retry settles. Must not throw. */
  onRetry?: (event: ConnectionRetryEvent) => void;
};

type QueryParams = {
  model?: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
  /**
   * Prisma's internal request: `transaction` is set when the query belongs to an interactive
   * (`$transaction(async (tx) => …)`) or batch (`$transaction([…])`) transaction. Undocumented, so
   * read defensively; the pg-backed test pins it on the installed version.
   */
  __internalParams?: { transaction?: unknown };
};

/**
 * Run one query, retrying it once if it is a read outside any transaction and failed with a
 * closed-connection error. Anything else (a write, a query in a transaction, any other error, or a
 * second failure) propagates unchanged.
 *
 * Never inside a transaction: the transaction lives on the connection that closed, so it is already
 * gone, and a retry would either fail on the dead transaction or, worse, run outside it.
 */
export async function runWithConnectionRetry(
  params: QueryParams,
  options: ConnectionRetryOptions = {}
): Promise<unknown> {
  const { model, operation, args, query, __internalParams } = params;
  try {
    return await query(args);
  } catch (error) {
    if (
      !RETRYABLE_READS.has(operation) ||
      __internalParams?.transaction ||
      !isClosedConnectionError(error)
    )
      throw error;
    try {
      const result = await query(args);
      options.onRetry?.({ model, operation, error, result: 'ok' });
      return result;
    } catch (retryError) {
      options.onRetry?.({ model, operation, error, result: 'failed' });
      throw retryError;
    }
  }
}

/**
 * The retry as a Prisma query extension. Applied to every client: writes pass through untouched, and
 * `$queryRaw`/`$executeRaw` are not model operations, so they are never retried (a raw statement can
 * be a write, and nothing here can tell).
 */
export const connectionRetryExtension = (options: ConnectionRetryOptions = {}) =>
  Prisma.defineExtension({
    name: 'connection-retry',
    query: {
      $allModels: Object.fromEntries(
        RETRYABLE_READ_OPERATIONS.map((operation) => [
          operation,
          (params: QueryParams) => runWithConnectionRetry(params, options),
        ])
      ),
    },
  });
