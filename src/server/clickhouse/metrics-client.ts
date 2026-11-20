// A dedicated ClickHouse for entity metrics. Read ONLY by the image MetricService, and only while
// the `image-metrics-dedicated-clickhouse` flag is on (`getImageMetricService` in image.service).
//
// Built by the same factory as the shared client in ./client, so it carries the same transport
// settings (compression, keep-alive, pool); only the connection and the request timeout differ
// (CLICKHOUSE_METRICS_REQUEST_TIMEOUT_MS, default 10s, instead of the shared client's 300s). Every
// connection field is passed, the password included when unset, so none of the shared client's
// credentials can reach this server through the factory's env defaults.
//
// Its own module rather than another export of ./client: a test that mocks ./client with a fixed
// export list would otherwise throw on the first read of this one.
//
// Unlike the shared client, a read that fails at the connection level is re-sent once (see
// ./retry-on-connection-reset): a restart of this server otherwise fails every read still holding a
// keep-alive socket to it.
import {
  createClickhouseClient,
  type CreateClickhouseClientOptions,
  type CustomClickHouseClient,
} from '@civitai/clickhouse/client';
import { registerCounterWithLabels } from '@civitai/telemetry/client';
import { env } from '~/env/server';
import { withConnectionResetRetry } from '~/server/clickhouse/retry-on-connection-reset';
import { createLogger } from '~/utils/logging';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalClickhouseMetrics: CustomClickHouseClient | undefined;
}

const retryCounter = registerCounterWithLabels({
  name: 'image_metrics_clickhouse_retry_total',
  help: 'Dedicated metrics ClickHouse reads re-sent once after a connection-level error (reset, broken pipe, refused), by whether the retry succeeded',
  labelNames: ['outcome'] as const,
});

export function createClickhouseMetricsClient(
  options: CreateClickhouseClientOptions
): CustomClickHouseClient {
  return withConnectionResetRetry(createClickhouseClient(options), {
    onRetry: (outcome) => retryCounter.inc({ outcome }),
  });
}

const shouldConnect =
  !env.IS_BUILD && env.CLICKHOUSE_METRICS_HOST && env.CLICKHOUSE_METRICS_USERNAME;

// Process-global, as in ./client: one client per process however many module graphs load this.
export const clickhouseMetrics: CustomClickHouseClient | undefined = !shouldConnect
  ? undefined
  : (globalThis.globalClickhouseMetrics ??= createClickhouseMetricsClient({
      log: createLogger('clickhouse', 'blue'),
      host: env.CLICKHOUSE_METRICS_HOST,
      username: env.CLICKHOUSE_METRICS_USERNAME,
      password: env.CLICKHOUSE_METRICS_PASSWORD,
      requestTimeoutMs: env.CLICKHOUSE_METRICS_REQUEST_TIMEOUT_MS,
    }));
