// Package-owned env schema for @civitai/db. Mirrors the postgres slice of the app's
// server-schema.ts so any app validates the same vars the same way on deployment.
import * as z from 'zod';

const booleanString = z.preprocess((val) => val === true || val === 'true', z.boolean());
const commaDelimitedStringArray = z.preprocess((val) => {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string')
    return val
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}, z.string().array());

// Strict integer env values: digits only, so '', ' 3', '2.5' and '-1' are rejected instead of being
// coerced (z.coerce turns '' into 0). Mirrored in src/env/server-schema.ts.
const intString = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .regex(/^\d+$/, 'expected a whole number')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
// A bare hostname or IPv4 address: no scheme, userinfo, port, path or IPv6 literal. The URL host
// setter silently truncates at '/', ':' or '@', so these must be rejected rather than "applied".
const HOSTNAME_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

export const dbEnvSchema = z.object({
  DATABASE_URL: z.url(),
  DATABASE_REPLICA_URL: z.url(),
  DATABASE_REPLICA_LONG_URL: z.url().optional(),
  DATABASE_SSL: booleanString.default(true),
  // Optional: only the notifications app (apps/notifications) reaches the notification DB now, and it
  // reads these via process.env directly (createClients), not loadDbEnv. `getClient` no longer has a
  // notification instance, so the monolith doesn't require them.
  NOTIFICATION_DB_URL: z.url().optional(),
  NOTIFICATION_DB_REPLICA_URL: z.url().optional(),
  DATAPACKET_DATABASE_RO_URL: z.url().optional(),
  APPS_DATABASE_URL: z.url().optional(),
  APPDATA_DATABASE_URL: z.url().optional(),
  // Document-store pool: sized on its own (not DATABASE_POOL_MAX) and optionally rerouted (e.g.
  // through a connection pooler) by replacing only the host/port of APPDATA_DATABASE_URL.
  APPDATA_POOL_MAX: intString(1).default(4),
  APPDATA_POOL_IDLE_TIMEOUT: intString(0).optional(),
  APPDATA_DATABASE_HOST: z
    .string()
    .regex(HOSTNAME_PATTERN, 'expected a hostname or IPv4 address')
    .optional(),
  APPDATA_DATABASE_PORT: intString(1, 65535).optional(),
  DATABASE_CONNECTION_TIMEOUT: z.coerce.number().default(0),
  DATABASE_POOL_MAX: z.coerce.number().default(20),
  NOTIFICATION_POOL_MAX: z.coerce.number().optional(),
  DATABASE_POOL_IDLE_TIMEOUT: z.coerce.number().default(30000),
  DATABASE_READ_TIMEOUT: z.coerce.number().optional(),
  DATABASE_WRITE_TIMEOUT: z.coerce.number().optional(),
  IS_DATAPACKET: booleanString.default(false),
  PODNAME: z.string().optional(),
  LOGGING: commaDelimitedStringArray,
});

// Normalized, env-derived defaults. Factories accept a Partial<DbConfig> to override.
function buildEnv() {
  const parsed = dbEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      '[@civitai/db] Invalid environment variables:\n' + z.prettifyError(parsed.error)
    );
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    replicaUrl: parsed.data.DATABASE_REPLICA_URL,
    replicaLongUrl: parsed.data.DATABASE_REPLICA_LONG_URL,
    ssl: parsed.data.DATABASE_SSL,
    notificationUrl: parsed.data.NOTIFICATION_DB_URL,
    notificationReplicaUrl: parsed.data.NOTIFICATION_DB_REPLICA_URL,
    datapacketReadUrl: parsed.data.DATAPACKET_DATABASE_RO_URL,
    appsUrl: parsed.data.APPS_DATABASE_URL,
    appdataUrl: parsed.data.APPDATA_DATABASE_URL,
    appdataPoolMax: parsed.data.APPDATA_POOL_MAX,
    appdataPoolIdleTimeout: parsed.data.APPDATA_POOL_IDLE_TIMEOUT,
    appdataHost: parsed.data.APPDATA_DATABASE_HOST,
    appdataPort: parsed.data.APPDATA_DATABASE_PORT,
    connectionTimeout: parsed.data.DATABASE_CONNECTION_TIMEOUT,
    poolMax: parsed.data.DATABASE_POOL_MAX,
    notificationPoolMax: parsed.data.NOTIFICATION_POOL_MAX,
    poolIdleTimeout: parsed.data.DATABASE_POOL_IDLE_TIMEOUT,
    readTimeout: parsed.data.DATABASE_READ_TIMEOUT,
    writeTimeout: parsed.data.DATABASE_WRITE_TIMEOUT,
    isDatapacket: parsed.data.IS_DATAPACKET,
    podName: parsed.data.PODNAME,
    logging: parsed.data.LOGGING,
    // NODE_ENV is a universal Node convention; the Next build guard lives in the app shim.
    isProd: process.env.NODE_ENV === 'production',
  };
}

export type DbConfig = ReturnType<typeof buildEnv>;
export type DbLogFn = (message: string, ...args: unknown[]) => void;

// Lazy + memoized: importing this module never touches process.env. Validation runs
// only when a factory calls loadDbEnv(), so a bare import (build, script, test) never
// throws. Parsed once, then cached.
let _env: DbConfig | undefined;
export function loadDbEnv(): DbConfig {
  return (_env ??= buildEnv());
}
