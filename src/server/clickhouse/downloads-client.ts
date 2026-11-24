// A dedicated analytics replica for download reads. Read ONLY by the user-downloads cache lookup
// (`userDownloadsCache` in ~/server/redis/caches) and the download limiter's count
// (`fetchDownloadCount` in ~/server/utils/download-count), each only while its own flag is on
// (~/server/services/downloads-clickhouse).
//
// Built by the dedicated metrics client's factory (./metrics-client), so it carries the shared
// client's transport settings plus the one-shot re-send of a read that fails at the connection
// level. Its request timeout is 2s: both reads are small, and on a failure the caller re-runs the
// read once on the shared client, so a hung replica must give up well inside a request's budget.
// Every connection field is passed, the password included when unset, so none of the shared
// client's credentials can reach this server through the factory's env defaults.
//
// Its own module, for the reason ./metrics-client gives.
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
  const result = await clickhouseDownloads.query({ query, format: 'JSONEachRow', query_params });
  return result.json<T>();
}
