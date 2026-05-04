# Middleware Performance Improvements

Tracker for outstanding performance work on the Edge middleware chain in
[src/server/middleware/](../src/server/middleware/). Two high-priority items
were already shipped (`previewAuthMiddleware` caching/timeout,
`regionRestrictionMiddleware` env-var hoisting). This document covers what's
still on the table.

## Status legend

| | |
|---|---|
| ✅ | Shipped |
| ⏳ | Planned, not started |
| 🤔 | Flagged, decision deferred |

---

## ✅ Shipped

### `previewAuthMiddleware` — Flipt fetch caching + timeout

**Was**: Synchronous `fetch` to Flipt on every non-static request in preview
deploys. No cache, no timeout. Could hang every preview-build navigation.

**Now**: 60-second in-memory cache keyed by `flagKey:entityId`, 2-second
`AbortSignal.timeout`, env vars hoisted to module init. Eliminates ~99% of
redundant Flipt round-trips for the same user across navigations.

Edge-runtime safe (uses a plain `Map`, not `~/server/utils/ttl-cache.ts` —
the latter pulls in `prom-client` and DB modules that don't run on Edge).

### `regionRestrictionMiddleware` — env-var hoisting

**Was**: `parseGreenHosts()` called inside `shouldRun` on every request that
matched the broad regex matcher. Re-parsed `SERVER_DOMAIN_GREEN` and
`SERVER_DOMAIN_GREEN_ALIASES`, allocated a new array each time.

**Now**: `GREEN_HOSTS` and `GREEN_DOMAIN_PRIMARY` parsed once at module init
via IIFE. Per-request cost drops to a constant array `.includes()`.

---

## ⏳ Medium priority — `getRegion` redundancy across region middlewares

[`getRegion`](../src/server/utils/region-blocking.ts) is called independently
by `regionBlockMiddleware`, `regionRestrictionMiddleware`, and
`apiRegionBlockMiddleware`. For requests matching more than one (most page
loads match the first two), the `RegionInfo` object is rebuilt from headers
each time.

The work itself is cheap (3 header reads + object construction), but it's
redundant. More importantly, the underlying issue — no shared scratch space
between middlewares in the chain — is reusable infrastructure for any future
cross-middleware data (parsed UA, parsed cookies, etc.).

### Proposed change

Add a per-request memoization slot to the `runMiddlewares` ctx:

1. **Extend `Middleware` ctx** in
   [middleware-utils.ts:8-12](../src/server/middleware/middleware-utils.ts#L8-L12):
   ```ts
   handler: (ctx: {
     request: NextRequest;
     user: SessionUser | null;
     redirect: ...;
     cache: Map<string, unknown>; // ← new
   }) => ...
   ```
2. **Construct the map** at the top of
   [`runMiddlewares`](../src/server/middleware/index.ts) and thread it through
   each `middleware.handler({ ... })` call.
3. **Wrap `getRegion`** with a memoized variant that reads/writes through
   `ctx.cache`:
   ```ts
   export function getRegionCached(req, cache) {
     let r = cache.get('region') as RegionInfo | undefined;
     if (!r) {
       r = getRegion(req);
       cache.set('region', r);
     }
     return r;
   }
   ```
4. **Update the three region middlewares** to call `getRegionCached(request, cache)`.

### Trade-off

**Not a real perf win in isolation.** Adds ~100-200ns of cache infrastructure
per request (Map allocation + lookups) to save ~200-500ns from one redundant
`getRegion` call — roughly a wash. Only worth doing as foundation if/when we
need to share other parsed-once data between middlewares (parsed UA, parsed
cookies, etc.). For getRegion alone, skip it.

**Estimated change size**: ~30 lines across 4 files. Low risk — purely
additive.

---

## ✅ Static-file extension regex (cleanliness)

[`shouldRunRegionMiddleware`](../src/server/middleware/region-middleware-utils.ts)
now uses a precompiled regex instead of `staticFileExtensions.some(...)`.

**Was not actually a perf win**: the original `pathname.includes('.')` guard
short-circuited in ~10ns for paths without a dot (most page traffic), which
is faster than a regex test. The regex is roughly equal or slightly slower
on the typical hot path. Shipped purely for code clarity — the redundant
`includes('.')` guard goes away and the array of strings becomes one
self-documenting pattern.

---

## 🤔 Deferred — `apiCacheMiddleware` allocation

[`apiCacheMiddleware`](../src/server/middleware/api-cache.middleware.ts) calls
`NextResponse.next()` and mutates response headers on every API request, even
when the only effect is `Cache-Control: max-age=0` (which is the default for
SSR responses anyway).

Two options:

- **Leave as-is.** Allocation cost is ~µs and the behavior is correct.
- **Skip the interception** unless we're actually adding a header value not
  already produced by the route. Risky — defaults are load-bearing across
  many tRPC and REST routes that may rely on the explicit `no-cache`.

**Recommendation**: leave it unless profiling identifies a hot path. Listed
here so we don't re-discover it.

---

## ✅ `redirectsMiddleware` removed — moved to `next.config.mjs`

Previously declared `useSession: true` because the `/user/@me` redirect
needed the current user, which forced the runner to JWT-verify (~50-200µs)
on every `/user/*` request — including all the ones that didn't actually
need it.

**Resolved by**:

1. Removing `/user/@me` (no internal links referenced it).
2. Changing `/user/civitai → /404` to `/user/civitai → /user/CivitaiOfficial`.
3. Moving the remaining redirect from middleware into `next.config.mjs`'s
   `redirects()` array. Next.js processes config-level redirects **before**
   middleware runs, so `/user/civitai` never hits the middleware chain.

The middleware file is deleted. The runner no longer iterates a redirect
entry for any `/user/*` request.

**Savings**:

- ~50-200µs per `/user/<username>` request (no JWT verify)
- One fewer middleware iteration in the chain on every request
- `/user/civitai` itself: framework-level redirect, no JS execution per
  request (faster than middleware-driven redirect)

---

## How `runMiddlewares` short-circuits today (just for reference)

For every request matching the outer `src/middleware.ts` matcher, the runner
iterates `middlewares` in order. Each entry can:

- **Decline via `shouldRun`** (default checks `pathname.startsWith` against
  the matcher's prefix bases) — runs in microseconds, doesn't touch the
  handler
- **Run the handler and return void** — chain continues
- **Run the handler and return a `NextResponse`** — short-circuits the chain
  and is the final response

`getToken` (next-auth JWT verify) is fetched at most once per request — the
runner caches the result in the local `user` variable across iterations. This
avoids redundant crypto work even when multiple middlewares declare
`useSession: true`.

The `botDetectionMiddleware` is intentionally **last** so its
`NextResponse.next({ request: { headers } })` (which propagates a modified
request header to downstream handlers) doesn't short-circuit any middleware
that hasn't run yet.
