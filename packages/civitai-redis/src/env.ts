// Package-owned env schema for @civitai/redis. Mirrors the redis slice of the app's
// server-schema.ts so any app validates the same vars the same way on deployment.
import * as z from 'zod';

// Exported for unit tests (validates the sentinel superRefine + the HA defaults without the
// memoized loadRedisEnv singleton). Not part of the package's public API surface (index.ts).
export const redisEnvSchema = z
  .object({
    REDIS_URL: z.url(),
    REDIS_SYS_URL: z.url(),
    REDIS_TIMEOUT: z.preprocess((x) => (x ? parseInt(String(x)) : 5000), z.number().optional()),
    REDIS_CLUSTER: z.preprocess((x) => x === 'true', z.boolean().default(false)),
    // Comma-separated list of cluster node URLs for redundant discovery
    REDIS_CLUSTER_NODES: z.string().optional(),
    // Topology refresh interval in ms (default 30s)
    REDIS_CLUSTER_REFRESH_INTERVAL: z.coerce.number().default(30000),
    // sysRedis HA (Phase 1): when REDIS_SYS_SENTINELS is set the system client is built
    // via Sentinel discovery instead of the single REDIS_SYS_URL connection. Comma-separated
    // host:port list, e.g. "civitai-app-sysredis-sentinel...:26379".
    REDIS_SYS_SENTINELS: z.string().optional(),
    // Required whenever REDIS_SYS_SENTINELS is set (cluster uses "sysmaster") — see superRefine.
    REDIS_SYS_SENTINEL_NAME: z.string().optional(),
    // Only set if sentinel-auth is enabled (not initially).
    REDIS_SYS_SENTINEL_PASSWORD: z.string().optional(),
    // Socket-level inactivity guard (node-redis -> net.Socket.setTimeout). On a SILENT
    // half-open the idle timer tears the dead socket down in ~this many ms instead of
    // ~30s OS TCP keepalive (the 504-cascade structural fix). Cluster (cache) client.
    REDIS_SOCKET_TIMEOUT_MS: z.coerce.number().default(10000),
    // System client socketTimeout — default 0 (disabled): a blanket aggressive teardown
    // on the flaky single-replica sysRedis caused a reconnect storm (#2556/#2586 wedge).
    REDIS_SYS_SOCKET_TIMEOUT_MS: z.coerce.number().default(0),
    // System client reply-queue cap: with socketTimeout disabled, bounds heap growth on a
    // silent half-open by fast-failing new commands (fail-open callers catch it). 0 = off.
    REDIS_SYS_COMMANDS_QUEUE_MAX_LENGTH: z.coerce.number().default(10000),
    // Keepalive PING interval. Kept comfortably below the socketTimeout — client.ts clamps
    // it to min(this, socketTimeout/2) so a healthy idle socket never spuriously fires.
    REDIS_PING_INTERVAL_MS: z.coerce.number().default(5000),
    // Cluster-only per-command wall-clock backstop BENEATH REDIS_SOCKET_TIMEOUT_MS: a ~0.5%
    // minority of cluster `_execute` promises never settle and park the SSR handler ~125s.
    // Racing against a rejecting deadline guarantees the command settles. 0 = off.
    REDIS_CLUSTER_COMMAND_TIMEOUT_MS: z.coerce.number().default(15000),
    // Used only to derive a hostname for the failover feature-flag context
    NEXTAUTH_URL: z.string().optional(),
    FLIPT_DEPLOYMENT_ID: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    // node-redis's createSentinel requires the master group name; refuse to start with
    // REDIS_SYS_SENTINELS set but REDIS_SYS_SENTINEL_NAME missing. The non-sentinel path
    // (REDIS_SYS_URL only) is unaffected.
    if (env.REDIS_SYS_SENTINELS && !env.REDIS_SYS_SENTINEL_NAME) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_SYS_SENTINEL_NAME'],
        message:
          'REDIS_SYS_SENTINEL_NAME is required when REDIS_SYS_SENTINELS is set (cluster uses "sysmaster")',
      });
    }
  });

// Normalized, env-derived defaults. The factory accepts a Partial<RedisConfig> to
// override any of these per call.
function buildEnv() {
  const parsed = redisEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error('[@civitai/redis] Invalid environment variables:\n' + z.prettifyError(parsed.error));
  }
  return {
    url: parsed.data.REDIS_URL,
    sysUrl: parsed.data.REDIS_SYS_URL,
    timeout: parsed.data.REDIS_TIMEOUT,
    cluster: parsed.data.REDIS_CLUSTER,
    clusterNodes: parsed.data.REDIS_CLUSTER_NODES,
    clusterRefreshInterval: parsed.data.REDIS_CLUSTER_REFRESH_INTERVAL,
    sysSentinels: parsed.data.REDIS_SYS_SENTINELS,
    sysSentinelName: parsed.data.REDIS_SYS_SENTINEL_NAME,
    sysSentinelPassword: parsed.data.REDIS_SYS_SENTINEL_PASSWORD,
    socketTimeoutMs: parsed.data.REDIS_SOCKET_TIMEOUT_MS,
    sysSocketTimeoutMs: parsed.data.REDIS_SYS_SOCKET_TIMEOUT_MS,
    sysCommandsQueueMaxLength: parsed.data.REDIS_SYS_COMMANDS_QUEUE_MAX_LENGTH,
    pingIntervalMs: parsed.data.REDIS_PING_INTERVAL_MS,
    clusterCommandTimeoutMs: parsed.data.REDIS_CLUSTER_COMMAND_TIMEOUT_MS,
    nextAuthUrl: parsed.data.NEXTAUTH_URL,
    fliptDeploymentId: parsed.data.FLIPT_DEPLOYMENT_ID,
  };
}

export type RedisConfig = ReturnType<typeof buildEnv>;

// Lazy + memoized: importing this module never touches process.env. Validation runs only
// when the factory calls loadRedisEnv(), so a bare import (build, script, test) never
// throws. Parsed once, then cached.
let _env: RedisConfig | undefined;
export function loadRedisEnv(): RedisConfig {
  return (_env ??= buildEnv());
}
