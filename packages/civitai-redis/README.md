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

| Var | Req | Notes |
|---|---|---|
| `REDIS_URL` | **yes** | cache client connection |
| `REDIS_SYS_URL` | **yes** | sysRedis connection |
| `REDIS_CLUSTER` | no | `true` to treat `REDIS_URL` as a cluster |
| `REDIS_SYS_SENTINELS` / `_NAME` | no | sysRedis HA via Sentinel discovery |
| `REDIS_CLUSTER_ERROR_REDISCOVER_ENABLED` | no | default on; `false` stops a cluster node's connection errors from triggering a slot-map re-read (the node-address-change fix) |
| `REDIS_CLUSTER_BATCHED_GET_ENABLED` | no | default on; `false` makes `packed.mGet` on a cluster issue one routed GET per key instead of pipelining each master's GETs together |
| `REDIS_SYS_COMMAND_TIMEOUT_MS` | no | sys per-command backstop, default `30000`; `0` disables it |
| `REDIS_SYS_SENTINEL_STALE_MASTER_GIVEUP_ENABLED` | no | Sentinel path, default on: master connections of a discovery that never had one up stop retrying once the Sentinel names another master that answers as one, so a discovery stuck on a gone master starts over; `false` retries forever |

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

The `cluster-*.integration.test.ts` files run a real 3-master Redis cluster in docker. Two move a node
to a new address and stop a node under a forced self-heal; they are **one-time evidence** for the
node-address-change fix. A third (`cluster-pipelined-get`) checks the batches a 200-key `packed.mGet`
sends and reads through a slot migration. `sentinel-master-loss` runs a master, a replica and a
Sentinel and removes the master for good, with the sys client running and with it starting during the
outage, and checks it follows the failover (evidence for the Sentinel master-loss fix); it also
restarts a master in place and checks it is found again (a guard: the old code recovers there too). The
evidence cases are run by hand to show red on the old code and green on the new — **not ongoing
coverage**: CI does not run them (they need `REDIS_CLUSTER_IT=1` and docker), so outside that they
report as skipped and a later regression in what they check would not be caught. To re-run them by
hand:

```bash
REDIS_CLUSTER_IT=1 pnpm --filter @civitai/redis exec vitest run integration
```

Linux only (the test dials the containers' bridge addresses). `REDIS_CLUSTER_IT_LOG=1` also prints the
client's own log lines.
