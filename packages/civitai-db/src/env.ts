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

const schema = z.object({
  DATABASE_URL: z.url(),
  DATABASE_REPLICA_URL: z.url(),
  DATABASE_REPLICA_LONG_URL: z.url().optional(),
  DATABASE_SSL: booleanString.default(true),
  NOTIFICATION_DB_URL: z.url(),
  NOTIFICATION_DB_REPLICA_URL: z.url(),
  DATAPACKET_DATABASE_RO_URL: z.url().optional(),
  APPS_DATABASE_URL: z.url().optional(),
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
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error('[@civitai/db] Invalid environment variables:\n' + z.prettifyError(parsed.error));
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
