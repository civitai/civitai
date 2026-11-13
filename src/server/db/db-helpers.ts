// App shim for @civitai/db helpers. Re-exports the generic pool/query utils from the package, owns the
// main app's instance-based `getClient` factory (the ONE place that knows the monolith's DB topology),
// and binds the app's dbWrite into the Prisma-dependent helpers so existing call sites (getCurrentLSN(),
// checkNotUpToDate(lsn), dbKV) keep their signatures.
export * from '@civitai/db/db-helpers';

import {
  createPgPoolAcquireHistogram,
  createPool,
  PG_POOL_ACQUIRE_HISTOGRAM_NAME,
} from '@civitai/db/db-helpers';
import { instrumentationRegistry, registerInstrumentationMetric } from '@civitai/telemetry/client';
import { loadDbEnv, type DbConfig, type DbLogFn } from '@civitai/db';
import {
  getCurrentLSN as _getCurrentLSN,
  checkNotUpToDate as _checkNotUpToDate,
  makeDbKV,
} from '@civitai/db/kv-helpers';
import { dbWrite } from '~/server/db/client';

export const getCurrentLSN = () => _getCurrentLSN(dbWrite);
export const checkNotUpToDate = (lsn: string) => _checkNotUpToDate(dbWrite, lsn);
export const dbKV = makeDbKV(dbWrite);

// The monolith's known databases. The shared @civitai/db package stays database-agnostic — its
// `createPool` / `createClients` take raw connection strings. THIS factory is where the app maps its own
// instances to URLs + per-instance pool policy (size, application_name, PgBouncer statement_timeout
// mode); nothing about the notification / datapacket / apps databases leaks into the package.
export type ClientInstanceType =
  | 'primary'
  | 'primaryRead'
  | 'primaryReadLong'
  | 'datapacketRead'
  | 'apps'
  | 'appdata';

export type GetClientOptions = Partial<DbConfig> & {
  instance?: ClientInstanceType;
  /** Debug logger (app-defined). Defaults to a no-op. */
  log?: DbLogFn;
};

// The pools are process-global (pgDb.ts), so whichever module graph builds them first owns their
// closures; the acquire histogram must therefore live in the cross-graph registry /api/metrics reads.
const pgPoolAcquireHistogram = registerInstrumentationMetric(PG_POOL_ACQUIRE_HISTOGRAM_NAME, () =>
  createPgPoolAcquireHistogram([instrumentationRegistry])
);

export function getClient(options: GetClientOptions = {}) {
  const { instance = 'primary', log: logOption, ...envOverrides } = options;
  const config = { ...loadDbEnv(), ...envOverrides };
  const log: DbLogFn = logOption ?? (() => {});

  const instanceUrlMap: Record<ClientInstanceType, string> = {
    primary: config.databaseUrl,
    primaryRead: config.replicaUrl ?? config.databaseUrl,
    primaryReadLong: config.replicaLongUrl ?? config.databaseUrl,
    datapacketRead: config.datapacketReadUrl ?? config.databaseUrl,
    // App Blocks KV datastore — empty-string sentinel when unset; appsDb never calls getClient
    // unless APPS_DATABASE_URL is configured (see src/server/db/appsDb.ts).
    apps: config.appsUrl ?? '',
    // App Blocks document store (least-privilege role) — same sentinel; appdataDb
    // never calls getClient unless APPDATA_DATABASE_URL is configured.
    appdata: config.appdataUrl ?? '',
  };

  const envUrl =
    instance === 'appdata'
      ? withHostOverride(instanceUrlMap.appdata, config.appdataHost, config.appdataPort)
      : instanceUrlMap[instance];
  const isAppdata = instance === 'appdata';
  const appBaseName =
    instance === 'datapacketRead'
      ? 'dp-read-pg'
      : instance === 'apps'
      ? 'apps-pg'
      : instance === 'appdata'
      ? 'appdata-pg'
      : 'node-pg';

  // DO managed Postgres PgBouncer rejects statement_timeout as a startup parameter — datapacketRead sets
  // it per-connection via SET instead (createPool wires it).
  const perConnectionStatementTimeout =
    config.isDatapacket && instance === 'datapacketRead' ? config.readTimeout ?? 120000 : undefined;

  return createPool({
    connectionString: envUrl,
    label: instance,
    ssl: config.ssl,
    applicationName: `${appBaseName}${config.podName ? '-' + config.podName : ''}`,
    connectionTimeoutMillis: config.isDatapacket
      ? config.connectionTimeout || 5000
      : config.connectionTimeout,
    // The document store has its own, smaller pool (APPDATA_POOL_MAX): it must not take a full
    // DATABASE_POOL_MAX of connections per process on top of the main pools.
    max: isAppdata ? config.appdataPoolMax : config.poolMax,
    idleTimeoutMillis:
      instance === 'primaryReadLong'
        ? 300_000 // trying this for leaderboard job
        : isAppdata
        ? config.appdataPoolIdleTimeout ?? config.poolIdleTimeout
        : config.poolIdleTimeout,
    statementTimeout:
      instance === 'datapacketRead' && config.isDatapacket
        ? undefined // DP: set per-connection (PgBouncer ignores startup params)
        : instance === 'primaryRead'
        ? config.readTimeout
        : config.writeTimeout,
    perConnectionStatementTimeout,
    log,
    acquireHistogram: pgPoolAcquireHistogram,
  });
}

/**
 * Replace the host and/or port of a connection string, keeping its user, password, database and
 * query — so the document-store pool can be pointed at a connection pooler without editing the
 * secret that holds its URL. Neither set → the string is returned untouched.
 *
 * Pooler compatibility of what this pool sends: node-postgres's startup packet carries `user`,
 * `database`, `application_name` and — only when DATABASE_WRITE_TIMEOUT is set — `statement_timeout`.
 * A pooler that rejects unknown startup parameters must be told to ignore `statement_timeout` (and
 * then does not apply it). The document store keeps no session state: its settings are
 * `set_config(…, true)` inside each transaction, its statements are unnamed, and it never LISTENs, so
 * it is safe under transaction pooling.
 */
function withHostOverride(url: string, host: string | undefined, port: number | undefined): string {
  if (!url || (host === undefined && port === undefined)) return url;
  const parsed = new URL(url);
  if (host !== undefined) {
    parsed.hostname = host;
    // The host setter silently truncates at '/', ':' or '@' instead of throwing; refuse rather than
    // connect to a host nobody configured. The env schema rejects these first.
    if (parsed.hostname.toLowerCase() !== host.toLowerCase()) {
      throw new Error('APPDATA_DATABASE_HOST is not a bare hostname or IPv4 address');
    }
  }
  if (port !== undefined) parsed.port = String(port);
  return parsed.toString();
}
