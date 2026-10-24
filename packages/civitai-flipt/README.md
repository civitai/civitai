# @civitai/flipt

Feature-flag evaluation via [Flipt](https://flipt.io) for Civitai apps. Wraps the wasm client with the
production hardening the monolith needed: init timeout + failure circuit breaker, an in-process TTL
eval cache, and dev-only local overrides. Fails **closed** — an unreachable Flipt or an unknown flag
evaluates to `false` / `null`, never throws.

## Add to an app

```jsonc
// package.json
"@civitai/flipt": "workspace:*"
```

Transpile (raw TS): Next `transpilePackages: ['@civitai/flipt']`, Vite `ssr.noExternal: ['@civitai/flipt']`.

## Env

| Var | Req | Notes |
|---|---|---|
| `FLIPT_URL` | **yes** | Flipt server |
| `FLIPT_FETCHER_SECRET` | **yes** | client token |
| `FLIPT_ENVIRONMENT` | no | Flipt environment; defaults to `civitai-app` |
| `FLIPT_DEPLOYMENT_ID` | no | carried on `config`, for apps that put it in evaluation context |
| `FLIPT_EVAL_CACHE_TTL_MS` | no | default `10000`; `0` disables the eval cache |
| `FLIPT_LOCAL_OVERRIDES` | no | dev only — ignored when `NODE_ENV=production` |

Env is read lazily: importing this package touches nothing, `createFliptClient()` reads only the
optional tuning vars, and `FLIPT_URL`/`FLIPT_FETCHER_SECRET` are resolved on the **first evaluation**
(skipped entirely if the app passed them). A missing connection var therefore degrades that instance
to fail-closed via `onInitError` — it never throws out of the import that built it.

## Use

```ts
// src/lib/server/flipt.ts (or src/server/flipt/client.ts in the monolith)
import { createFliptClient } from '@civitai/flipt';

export const flipt = createFliptClient({
  cacheBypass: [MY_FLAGS.SOME_KILL_SWITCH],
  onInitError: (error) => logToAxiom({ type: 'init-flipt-error', error: safeError(error) }),
});
```

```ts
if (await flipt.isEnabled('feed-post-filter', String(userId))) { … }
const mode = await flipt.getVariant('some-variant-flag', String(userId));
```

| Method | Overrides honored | Notes |
|---|---|---|
| `isEnabled` | yes | the default boolean read |
| `getBoolean` | **no** | when the call site must see real Flipt state, not a dev `.env` |
| `getVariant` | yes | `null` when unmatched |
| `isEnabledSync` | yes | `null` if the client hasn't initialized — caller falls back |
| `ensureInitialized` | — | warm it at boot so `isEnabledSync` can answer |

**Flag keys stay in the app.** This package deliberately ships no flag enum: flags are owned by the
app that gates on them (the monolith's list is `FLIPT_FEATURE_FLAGS` in
`src/server/flipt/client.ts`). Two apps sharing a flag share the *string*, not an import.

## Gotchas

- **Eval-cache staleness is additive to the config poll.** Worst-case propagation of a flipped flag is
  ~(60s poll + TTL) per pod, and pods converge independently. Fine for rollout flags; put incident
  kill-switches in `cacheBypass` so an operator's flip takes effect on the next poll alone.
- **Prefer lowering `FLIPT_EVAL_CACHE_TTL_MS` over growing `cacheBypass`.** Bypassing a flag evaluated
  on a hot path re-adds a per-request wasm call — that cache exists because those calls were a top-10
  CPU frame at ~1500 req/s.
- 🔴 **Before changing either cache knob, read `getCacheStats()` — a hit rate alone cannot tell you
  which knob to turn.** The two failure modes look identical from a hit rate and have opposite
  remedies:
  - misses dominated by `expiredMisses` → **TTL-bound**: the key was cached and its TTL lapsed, so a
    longer `FLIPT_EVAL_CACHE_TTL_MS` converts those misses into hits.
  - `rotations` climbing → **capacity-bound**: inserts are overflowing `evalCacheMaxEntries`, so
    entries are evicted *before* they can expire. A longer TTL then recovers **nothing** — it is an
    inert change that reads as a fix. Raise the ceiling instead.

  Note the cache key is `(flag, entityId, context)`, so a per-user `entityId` multiplies the key
  space by your active-user count; capacity-bound is the likelier of the two on hot paths. The
  monolith exports these as `civitai_app_flipt_eval_cache_*` (see
  `src/server/metrics/flipt-eval-cache.metrics.ts`); `misses - expiredMisses` is an upper bound on
  cold traffic, not a measurement of it.
- **`FLIPT_EVAL_CACHE_TTL_MS` is parsed with `parseInt`**: `"0.5"` → `0` (cache off) and `"1e4"` → `1`.
  The resolved value is logged through the factory's `log` on startup — read it if behavior surprises you.
- After an init failure the client stays `null` for `failureCooldownMs` (30s) and every read returns
  the fail-closed value. That's deliberate: a flag store outage must not stall request paths.
- Logging is **injected** (`onInitError` / `onEvalError` / `log`), so this package depends on no
  transport. Without them you get `console`.
