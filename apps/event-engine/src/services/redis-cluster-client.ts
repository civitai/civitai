import { createCluster } from 'redis';
import { envTimeoutMs } from '@/utils/env-timeout';

/**
 * The event engine's cluster client. node-redis 6 changed three defaults; this pins the 5.x ones,
 * as packages/civitai-redis does:
 *  - RESP 2: 6.x defaults to RESP3, which changes reply shapes (multi().exec(), hGetAll); a move to
 *    RESP3 is its own change. Cluster-level, not in `defaults`: RedisCluster hands its own RESP to
 *    every node connection, over `defaults`.
 *  - `timeout: undefined`: 6.x rejects a command that waits more than 5 s to be written (e.g. one
 *    queued while its node reconnects).
 *  - keepAliveInitialDelay 5000: 6.x waits 30 s before the first TCP keepalive probe.
 * duplicate() copies these options, so the pub/sub connections get them too.
 *
 * And one bound node-redis does not set: a socket inactivity timeout (default 10 s, as the shared
 * cache client in packages/civitai-redis uses). A node that accepts a connection and then goes
 * silent parks every command on it, and with no command timeout an awaited cache call would wait
 * for the OS keepalive; the idle timer tears that socket down, rejecting what is in flight, and the
 * client reconnects. The keepalive PING (at most half the timeout) keeps a healthy idle socket from
 * tripping it. `REDIS_SOCKET_TIMEOUT_MS` overrides it; 0 turns it off.
 */
export const REDIS_SOCKET_TIMEOUT_MS = 10_000;
const REDIS_PING_INTERVAL_MS = 5_000;

export function createEngineCluster(
  url: URL,
  {
    socketTimeoutMs = envTimeoutMs(process.env.REDIS_SOCKET_TIMEOUT_MS, REDIS_SOCKET_TIMEOUT_MS),
  }: { socketTimeoutMs?: number } = {}
) {
  return createCluster({
    rootNodes: [{ url: `${url.protocol}//${url.host}` }],
    RESP: 2,
    commandOptions: { timeout: undefined },
    defaults: {
      username: url.username === '' ? undefined : url.username,
      password: url.password,
      socket: {
        keepAliveInitialDelay: 5000,
        ...(socketTimeoutMs ? { socketTimeout: socketTimeoutMs } : {}),
      },
      ...(socketTimeoutMs
        ? { pingInterval: Math.min(REDIS_PING_INTERVAL_MS, Math.floor(socketTimeoutMs / 2)) }
        : {}),
    },
  });
}
export type EngineRedisCluster = ReturnType<typeof createEngineCluster>;
