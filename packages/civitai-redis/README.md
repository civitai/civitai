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
