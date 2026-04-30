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

Adds one `new Map()` per request (~100ns) for the savings of two `getRegion`
calls. Net win is small per request, but the cache slot is a foundation any
future middleware can use for free. Worth doing as infrastructure even if
region-specific savings are modest.

**Estimated change size**: ~30 lines across 4 files. Low risk — purely
additive.

---

## ⏳ Low priority — static-file extension regex

[`shouldRunRegionMiddleware`](../src/server/middleware/region-middleware-utils.ts)
checks for static file extensions via:

```ts
if (pathname.includes('.') && staticFileExtensions.some((ext) => pathname.endsWith(ext))) {
  return false;
}
```

Could be replaced with a precompiled regex:

```ts
const STATIC_FILE_EXT_RE = /\.(ico|png|jpg|jpeg|gif|svg|webp|css|js|woff2?|ttf|eot|xml|json)$/i;
// in shouldRunRegionMiddleware:
if (STATIC_FILE_EXT_RE.test(pathname)) return false;
```

The redundant `pathname.includes('.')` guard goes away — the regex covers it.

**Savings**: ~150ns per request that doesn't match a static file. Negligible
at request scale; do it for cleanliness if/when somebody is in the area.

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

## 🤔 Deferred — `redirectsMiddleware` over-eager session fetch

[`redirectsMiddleware`](../src/server/middleware/redirects.middleware.ts)
declares `useSession: true` because the `/user/@me` redirect needs the
current user. But the runner pre-fetches the next-auth token before the
handler runs, so non-`@me` `/user/<username>` paths pay the JWT-verify cost
(~50-200µs of crypto) for nothing.

Two ways to skip the wasted token fetch:

1. **Split into two `addRedirect` calls**: one matcher for `/user/civitai`
   (no session needed), one for `/user/@me/:path*` (session needed). Requires
   `addRedirect` to support per-redirect `useSession`. Decent refactor of the
   helper.
2. **Move `useSession` from middleware-level to handler-level**, lazily
   fetching the token only when the handler actually accesses `user`. Larger
   change to the `Middleware` type and runner.

**Recommendation**: skip both unless `/user/<not-@me>` traffic shows up as a
hot path. Listed here for completeness.

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
