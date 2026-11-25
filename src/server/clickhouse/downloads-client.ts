// Every connection field is passed, the password included when unset, so none of the shared
// client's credentials can reach this server through the factory's env defaults.
import type { CustomClickHouseClient } from '@civitai/clickhouse/client';
import { registerCounterWithLabels } from '@civitai/telemetry/client';
import { env } from '~/env/server';
import { createClickhouseMetricsClient } from '~/server/clickhouse/metrics-client';
import { createLogger } from '~/utils/logging';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalClickhouseDownloads: CustomClickHouseClient | undefined;
}

export const DOWNLOADS_CLICKHOUSE_REQUEST_TIMEOUT_MS = 2_000;

const retryCounter = registerCounterWithLabels({
  name: 'downloads_clickhouse_retry_total',
  help: 'Dedicated downloads ClickHouse reads re-sent once after a connection-level error (reset, broken pipe, refused), by whether the retry succeeded',
  labelNames: ['outcome'] as const,
});

const shouldConnect =
  !env.IS_BUILD && env.CLICKHOUSE_DOWNLOADS_HOST && env.CLICKHOUSE_DOWNLOADS_USERNAME;

// Process-global, as in ./client: one client per process however many module graphs load this.
export const clickhouseDownloads: CustomClickHouseClient | undefined = !shouldConnect
  ? undefined
  : (globalThis.globalClickhouseDownloads ??= createClickhouseMetricsClient({
      log: createLogger('clickhouse', 'blue'),
      host: env.CLICKHOUSE_DOWNLOADS_HOST,
      username: env.CLICKHOUSE_DOWNLOADS_USERNAME,
      password: env.CLICKHOUSE_DOWNLOADS_PASSWORD,
      requestTimeoutMs: DOWNLOADS_CLICKHOUSE_REQUEST_TIMEOUT_MS,
      onRetry: (outcome) => retryCounter.inc({ outcome }),
    }));

// Sent with every read, so the server does not keep running one the client has given up on: it
// stops a read after 2s of execution (the client's own timeout is 2s without a byte), and cancels
// one whose connection the client has closed (a timed-out read already re-run on the shared client).
export const DOWNLOADS_CLICKHOUSE_QUERY_SETTINGS = {
  max_execution_time: 2,
  cancel_http_readonly_queries_on_client_close: 1,
} as const;

/**
 * One read on the dedicated client, rows as JSON. Through `query`, not `$query`: the factory's
 * connection-reset re-send wraps `query` only (`$query` calls the unwrapped client), and
 * `query_params` keeps every value out of the statement text. Throws when the client is not built;
 * callers check `clickhouseDownloads` first.
 */
export async function queryDownloadsClickhouse<T>(
  query: string,
  query_params?: Record<string, unknown>
): Promise<T[]> {
  if (!clickhouseDownloads) throw new Error('The downloads ClickHouse client is not configured');
  const result = await clickhouseDownloads.query({
    query,
    format: 'JSONEachRow',
    query_params,
    clickhouse_settings: DOWNLOADS_CLICKHOUSE_QUERY_SETTINGS,
  });
  return result.json<T>();
}
