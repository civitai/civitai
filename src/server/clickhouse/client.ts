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
}

const make = () => createClickhouseClient({ log: createLogger('clickhouse', 'blue') });

const shouldConnect = !env.IS_BUILD && env.CLICKHOUSE_HOST && env.CLICKHOUSE_USERNAME;
// Process-global in EVERY environment, not just for dev HMR: the production server evaluates this
// module once per bundler module graph in the same Node process, and each evaluation would otherwise
// open its own connections.
export const clickhouse: CustomClickHouseClient | undefined = !shouldConnect
  ? undefined
  : (globalThis.globalClickhouse ??= make());

// The Tracker is app-coupled (auth/session/schemas); it lives in the app and is
// re-exported here so existing `~/server/clickhouse/client` imports keep working.
export * from './tracker';
