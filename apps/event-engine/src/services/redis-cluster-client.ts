import { createCluster } from 'redis';

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
 */
export function createEngineCluster(url: URL) {
  return createCluster({
    rootNodes: [{ url: `${url.protocol}//${url.host}` }],
    RESP: 2,
    commandOptions: { timeout: undefined },
    defaults: {
      username: url.username === '' ? undefined : url.username,
      password: url.password,
      socket: { keepAliveInitialDelay: 5000 },
    },
  });
}
export type EngineRedisCluster = ReturnType<typeof createEngineCluster>;
