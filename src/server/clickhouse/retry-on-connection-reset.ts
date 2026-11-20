import type { ClickHouseClient } from '@clickhouse/client';
import { sleep } from '~/utils/errorHandling';

export type ConnectionRetryOutcome = 'ok' | 'failed';

type QueryParams = Parameters<ClickHouseClient['query']>[0];
type ResultSetLike = Awaited<ReturnType<ClickHouseClient['query']>>;
type BodyRead = 'json' | 'text';

// Node's socket error codes, which clickhouse-js passes through unchanged. A "socket hang up"
// and a reset mid-response ("aborted") both carry ECONNRESET. A server-side ClickHouse error
// carries its numeric code ('159' for TIMEOUT_EXCEEDED) and a client request timeout carries none,
// so neither can match.
const CONNECTION_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNREFUSED']);

function isConnectionLevelError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && CONNECTION_ERROR_CODES.has(code);
}

// Leading whitespace and SQL comments, then SELECT or WITH.
const READ_QUERY = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:SELECT|WITH)\b/i;

const MAX_RETRY_DELAY_MS = 50;

/**
 * Re-sends a read query ONCE when it fails at the connection level, so a keep-alive socket dropped
 * by a restarting server costs one extra request instead of a failed read. Only `query` with a
 * SELECT/WITH statement is retried; every other method is the client's own. A failure while
 * reading the body (`json()`/`text()`) re-sends the query and reads the new response the same way.
 * If the retry fails too, the FIRST error is rethrown, so callers classify exactly what they did
 * before. clickhouse-js destroys a socket that errored, so the retry runs on another one.
 */
export function withConnectionResetRetry<C extends ClickHouseClient>(
  client: C,
  { onRetry }: { onRetry: (outcome: ConnectionRetryOutcome) => void }
): C {
  // Never re-enters itself: the attempt runs on the unwrapped client, which bounds it at one.
  const retry = async <T>(original: unknown, attempt: () => Promise<T>): Promise<T> => {
    await sleep(Math.random() * MAX_RETRY_DELAY_MS);
    try {
      const result = await attempt();
      onRetry('ok');
      return result;
    } catch {
      onRetry('failed');
      throw original;
    }
  };

  const withBodyRetry = (params: QueryParams, resultSet: ResultSetLike): ResultSetLike => {
    const read =
      (method: BodyRead) =>
      async (...args: unknown[]) => {
        try {
          return await (resultSet[method] as (...a: unknown[]) => Promise<unknown>)(...args);
        } catch (error) {
          if (!isConnectionLevelError(error)) throw error;
          return retry(error, async () => {
            const fresh = await client.query(params);
            return (fresh[method] as (...a: unknown[]) => Promise<unknown>)(...args);
          });
        }
      };
    const json = read('json');
    const text = read('text');
    return new Proxy(resultSet, {
      get: (target, prop) =>
        prop === 'json' ? json : prop === 'text' ? text : Reflect.get(target, prop),
    });
  };

  const query = async (params: QueryParams): Promise<ResultSetLike> => {
    if (typeof params.query !== 'string' || !READ_QUERY.test(params.query))
      return client.query(params);
    try {
      return withBodyRetry(params, await client.query(params));
    } catch (error) {
      if (!isConnectionLevelError(error)) throw error;
      return retry(error, () => client.query(params));
    }
  };

  return new Proxy(client, {
    get: (target, prop) => (prop === 'query' ? query : Reflect.get(target, prop)),
  });
}
