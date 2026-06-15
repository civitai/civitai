// App shim for @civitai/redis. The package owns its env schema + the typed client
// wrappers and key definitions; the app injects behavior (debug logger + the Flipt
// failover policy), owns the HMR singleton + Next build guard, and re-exports the
// names existing call sites import from '~/server/redis/client'.
import { createRedisClients, type RedisClients } from '@civitai/redis/client';
import { isProd } from '~/env/other';
import { env } from '~/env/server';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { createLogger } from '~/utils/logging';

// Re-export the key definitions, types, and factory for other consumers.
export * from '@civitai/redis/client';

declare global {
  // eslint-disable-next-line no-var, vars-on-top
  var __civitaiRedisClients: RedisClients | undefined;
}

const log = createLogger('redis', 'green');

const make = (): RedisClients =>
  createRedisClients({
    log,
    isEnhancedFailoverEnabled: (ctx) =>
      isFlipt(FLIPT_FEATURE_FLAGS.REDIS_CLUSTER_ENHANCED_FAILOVER, 'redis-cluster', ctx),
  });

// Build guard is a Next.js concern → lives here, not in the package.
const clients: RedisClients = env.IS_BUILD
  ? { redis: undefined as never, sysRedis: undefined as never }
  : isProd
  ? make()
  : (global.__civitaiRedisClients ??= make());

export const redis = clients.redis;
export const sysRedis = clients.sysRedis;

/**
 * Wrap a redis client so each command rejects after REDIS_COMMAND_TIMEOUT_MS. ONLY for fail-open callers
 * that catch + degrade (at a non-fail-open site it turns a 30s park into a 500). Returns the client
 * unchanged when the timeout is disabled (env = 0) or the client lacks `withCommandOptions`. Note:
 * node-redis does NOT propagate the per-command timeout into MULTI/pipeline sub-commands.
 */
export function withRedisCommandTimeout<C>(client: C): C {
  const timeout = env.REDIS_COMMAND_TIMEOUT_MS;
  if (!timeout || timeout <= 0) return client;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const withOpts = (client as any).withCommandOptions;
  if (typeof withOpts !== 'function') return client;
  return withOpts.call(client, { timeout }) as C;
}
