// Package-owned env schema for @civitai/redis. Mirrors the redis slice of the app's
// server-schema.ts so any app validates the same vars the same way on deployment.
import * as z from 'zod';

const schema = z.object({
  REDIS_URL: z.url(),
  REDIS_SYS_URL: z.url(),
  REDIS_TIMEOUT: z.preprocess((x) => (x ? parseInt(String(x)) : 5000), z.number().optional()),
  REDIS_CLUSTER: z.preprocess((x) => x === 'true', z.boolean().default(false)),
  // Comma-separated list of cluster node URLs for redundant discovery
  REDIS_CLUSTER_NODES: z.string().optional(),
  // Topology refresh interval in ms (default 30s)
  REDIS_CLUSTER_REFRESH_INTERVAL: z.coerce.number().default(30000),
  // Used only to derive a hostname for the failover feature-flag context
  NEXTAUTH_URL: z.string().optional(),
  FLIPT_DEPLOYMENT_ID: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error('[@civitai/redis] Invalid environment variables:\n' + z.prettifyError(parsed.error));
}

// Normalized, env-derived defaults. The factory accepts a Partial<RedisConfig> to
// override any of these per call.
export const redisEnv = {
  url: parsed.data.REDIS_URL,
  sysUrl: parsed.data.REDIS_SYS_URL,
  timeout: parsed.data.REDIS_TIMEOUT,
  cluster: parsed.data.REDIS_CLUSTER,
  clusterNodes: parsed.data.REDIS_CLUSTER_NODES,
  clusterRefreshInterval: parsed.data.REDIS_CLUSTER_REFRESH_INTERVAL,
  nextAuthUrl: parsed.data.NEXTAUTH_URL,
  fliptDeploymentId: parsed.data.FLIPT_DEPLOYMENT_ID,
};

export type RedisConfig = typeof redisEnv;
