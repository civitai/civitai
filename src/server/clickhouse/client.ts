// App shim for @civitai/clickhouse. The package owns the base client + env schema; the
// app injects the debug logger, owns the HMR singleton + Next build guard, and re-exports
// the base client surface plus the app-side Tracker (./tracker) for existing call sites.
import { createClickhouseClient, type CustomClickHouseClient } from '@civitai/clickhouse/client';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { createLogger } from '~/utils/logging';

export * from '@civitai/clickhouse/client';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var globalClickhouse: CustomClickHouseClient | undefined;
}

const make = () => createClickhouseClient({ log: createLogger('clickhouse', 'blue') });

const shouldConnect = !env.IS_BUILD && env.CLICKHOUSE_HOST && env.CLICKHOUSE_USERNAME;
export const clickhouse: CustomClickHouseClient | undefined = !shouldConnect
  ? undefined
  : isProd
  ? make()
  : (global.globalClickhouse ??= make());

// The Tracker is app-coupled (auth/session/schemas); it lives in the app and is
// re-exported here so existing `~/server/clickhouse/client` imports keep working.
export * from './tracker';
