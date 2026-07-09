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

// Wall-clock deadline for per-request sysRedis reads — an app-side leaf (reads ~/env/server) so
// it's unit-testable without building the clients. Re-exported here because callers import it
// from '~/server/redis/client'.
export { withSysReadDeadline } from './sys-read-deadline';

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
