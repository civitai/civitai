// App shim for @civitai/clickhouse. The package owns the base client + env schema; the
// app injects the debug logger, owns the process singleton + Next build guard, and re-exports
// the base client surface plus the app-side Tracker (./tracker) for existing call sites.
import { createClickhouseClient, type CustomClickHouseClient } from '@civitai/clickhouse/client';
import { env } from '~/env/server';
import { createLogger } from '~/utils/logging';

export * from '@civitai/clickhouse/client';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalClickhouse: CustomClickHouseClient | undefined;
  // eslint-disable-next-line no-var, vars-on-top
  var globalClickhouseLongQueries: CustomClickHouseClient | undefined;
}

const make = () => createClickhouseClient({ log: createLogger('clickhouse', 'blue') });

const shouldConnect = !env.IS_BUILD && env.CLICKHOUSE_HOST && env.CLICKHOUSE_USERNAME;
// Process-global in EVERY environment, not just for dev HMR: the production server evaluates this
// module once per bundler module graph in the same Node process, and each evaluation would otherwise
// open its own connections.
export const clickhouse: CustomClickHouseClient | undefined = !shouldConnect
  ? undefined
  : (globalThis.globalClickhouse ??= make());

// For queries that bound themselves (max_execution_time plus an abort_signal) and may go quiet for
// minutes: a GROUP BY that spills to disk sends no progress headers while it merges, and the shared
// client's 300 s idle timer then drops a query the server is still running. Above every such
// query's own bound, so that bound is what stops it.
export const LONG_QUERY_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;
export const clickhouseLongQueries: CustomClickHouseClient | undefined = !shouldConnect
  ? undefined
  : (globalThis.globalClickhouseLongQueries ??= createClickhouseClient({
      log: createLogger('clickhouse', 'blue'),
      requestTimeoutMs: LONG_QUERY_REQUEST_TIMEOUT_MS,
    }));

// The Tracker is app-coupled (auth/session/schemas); it lives in the app and is
// re-exported here so existing `~/server/clickhouse/client` imports keep working.
export * from './tracker';
