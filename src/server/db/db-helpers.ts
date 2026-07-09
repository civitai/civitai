// App shim for @civitai/db helpers. Re-exports the generic pool/query utils from the package, owns the
// main app's instance-based `getClient` factory (the ONE place that knows the monolith's DB topology),
// and binds the app's dbWrite into the Prisma-dependent helpers so existing call sites (getCurrentLSN(),
// checkNotUpToDate(lsn), dbKV) keep their signatures.
export * from '@civitai/db/db-helpers';

import { createPool } from '@civitai/db/db-helpers';
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
  | 'apps';

export type GetClientOptions = Partial<DbConfig> & {
  instance?: ClientInstanceType;
  /** Debug logger (app-defined). Defaults to a no-op. */
  log?: DbLogFn;
};

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
  };

  const envUrl = instanceUrlMap[instance];
  const appBaseName =
    instance === 'datapacketRead' ? 'dp-read-pg' : instance === 'apps' ? 'apps-pg' : 'node-pg';

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
    max: config.poolMax,
    // trying this for leaderboard job
    idleTimeoutMillis: instance === 'primaryReadLong' ? 300_000 : config.poolIdleTimeout,
    statementTimeout:
      instance === 'datapacketRead' && config.isDatapacket
        ? undefined // DP: set per-connection (PgBouncer ignores startup params)
        : instance === 'primaryRead'
        ? config.readTimeout
        : config.writeTimeout,
    perConnectionStatementTimeout,
    log,
  });
}
