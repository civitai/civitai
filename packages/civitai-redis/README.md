# @civitai/redis

Redis clients for Civitai apps: the **cache** client (cluster-capable) and the **sysRedis** client
(system/coordination), with the production hardening baked in — socket-timeout teardown, cluster
self-heal watchdog, routing retries, packed (msgpack+brotli) values.

## Add to an app

```jsonc
// package.json
"@civitai/redis": "workspace:*"
```

Transpile (raw TS): Next `transpilePackages: ['@civitai/redis']`, Vite `ssr.noExternal: ['@civitai/redis']`.

Often you don't add this directly — it comes in via `@civitai/auth`. Add it explicitly when the app
builds its own client (caching, pub/sub, or to inject `isRevoked` into the auth guard).

## Env

| Var                                      | Req     | Notes                                                                                                                               |
| ---------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`                              | **yes** | cache client connection                                                                                                             |
| `REDIS_SYS_URL`                          | **yes** | sysRedis connection                                                                                                                 |
| `REDIS_CLUSTER`                          | no      | `true` to treat `REDIS_URL` as a cluster                                                                                            |
| `REDIS_SYS_SENTINELS` / `_NAME`          | no      | sysRedis HA via Sentinel discovery                                                                                                  |
| `REDIS_CLUSTER_ERROR_REDISCOVER_ENABLED` | no      | default on; `false` stops a cluster node's connection errors from triggering a slot-map re-read (the node-address-change fix)       |
| `REDIS_CLUSTER_BATCHED_GET_ENABLED`      | no      | default on; `false` makes `packed.mGet` on a cluster issue one routed GET per key instead of pipelining each master's GETs together |
| `REDIS_SYS_COMMAND_TIMEOUT_MS`           | no      | sys per-command backstop, default `30000`; `0` disables it, and with it the sys self-heal's timeout-rate trigger                    |

`loadRedisEnv()` **requires both `REDIS_URL` and `REDIS_SYS_URL`** — a partial config throws. Dozens of
optional tuning knobs (socket timeouts, self-heal thresholds, routing retries) have safe defaults; see
[src/env.ts](src/env.ts).

## Use

```ts
import { createRedisClients } from '@civitai/redis';

export const { redis, sysRedis } = createRedisClients();
// or just one: createCacheRedis() / createSysRedis()
```

`redis` exposes `.packed.get/set` (msgpack+brotli) alongside the standard commands. Key namespaces are
exported as `REDIS_KEYS`, `REDIS_SYS_KEYS`, `REDIS_SUB_KEYS`.

## Gotchas

- **Both URLs or neither**: setting only one throws on first use. This is the #1 footgun for apps that
  enable redis just for the auth cache.
- The clients are HMR/global-cached and self-healing in the package; the app shim just calls the factory.
- For real-time auth revocation, pass a sysRedis-backed `isRevoked` to `createSpokeGuard`.

Reference: the auth app ([apps/auth](../../apps/auth)) wires both clients.

## Tests

`pnpm --filter @civitai/redis test` runs the unit suite, which is what CI runs.

The `*.integration.test.ts` files run real Redis in docker (a 3-master cluster, or a master, a
replica and a Sentinel). `cluster-node-address-change` and `cluster-selfheal-bounded` move a node to a
new address and stop a node under a forced self-heal (evidence for the node-address-change fix);
`cluster-pipelined-get` checks the batches a 200-key `packed.mGet` sends and reads through a slot
migration. `sentinel-master-loss` removes the sys master for good, with the client running and with it
starting during the outage, and checks it follows the failover (red on node-redis 5.8.3 with no local guard, green on
6.3.0); it also restarts the master in place and checks it is found again. `client-defaults` checks,
against a server, what the node-redis 6 upgrade relies on: every client kind negotiates RESP2, opens
sockets with a 5 s keepalive delay and carries no node-redis command timeout; a routed cluster command
still passes through the instrumentation and its deadline; topology rediscovery and the routing-retry
classifier work on 6.x. They are run by hand — **not ongoing coverage**: CI does not run them (they
need `REDIS_CLUSTER_IT=1` and docker), so outside that they report as skipped and a later regression in
what they check would not be caught. Run them one file at a time (`--no-file-parallelism`): several
clusters starting at once can time out docker calls. To re-run them by hand:

```bash
REDIS_CLUSTER_IT=1 pnpm --filter @civitai/redis exec vitest run integration --no-file-parallelism
```

Linux only (the test dials the containers' bridge addresses). `REDIS_CLUSTER_IT_LOG=1` also prints the
client's own log lines.
