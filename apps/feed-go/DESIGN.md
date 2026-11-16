# feed-go — design

A Go service that answers one tRPC procedure, `image.getImagesAsPostsInfinite` (the model / Model3D
gallery feed), for the request shapes it has ported, and hands every other request back to the Node
app. It exists to **measure** one question before anything bigger is decided:

> Does moving a hot read path off Next.js / Node / Prisma cut the CPU spent per request enough to
> justify re-platforming more of them?

Measured in production, this procedure is the heaviest single tRPC procedure by CPU, and its cost is
diffuse — garbage collection, serialization, the Redis cache layer, the Prisma engine, framework
overhead — so no single Node-side fix removes it. A faithful port of one procedure, compared on the
same traffic, answers the question with a number instead of an argument.

This document covers what the service does, what it reuses, how it identifies the viewer, how traffic
reaches it, how parity is proven before it serves anyone, and how the CPU comparison is made. The
last sections list what is **not** at parity and what a deployment needs.

Three more ports run in **shadow only** (nothing routes public traffic to them): the public REST
endpoint `GET /api/v1/images` (§13), and the tRPC procedures `image.getInfinite`, the flat image feed
(§14), and `model.getAll`, the model browse feed (§15). They share the hydration readers, the caches
(and, except `model.getAll`, the feed-service client), the shadow queue and the metric families, told
apart by a `feed_endpoint` label (not `endpoint`: that is a reserved scrape target label, which would
overwrite ours).

---

## 1. What the Node procedure does

Router `src/server/routers/image.router.ts` (`heavyProcedure`, input `getInfiniteImagesSchema`) →
handler `getImagesAsPostsInfiniteHandler` (`src/server/controllers/image.controller.ts`) → read path
`getAllImages` / `getAllImagesIndex` (`src/server/services/image.service.ts`), picked by the
`image-index-feed` flag (`fetchFn`). **That flag is on in production**, so production pages come from
`getAllImagesIndex`: the image feed service (`FEED_SERVICE_URL`, `serveImagesFromFeedService` →
`serveFromFeed`) picks and orders a page of image ids for a query built by
`mapSearchInputToFeedQuery`, and the Postgres query of step 3 below, run with `ids` and without the
model scope, paging or period (`feedHydrateQuery`), supplies the rows. Its cursor is the feed's own
keyset, sent to clients as `feed:<a>:<b>`. With the flag off, every page is the Postgres path:

1. **Middleware** clamps the input's browsing level to the domain cap before the schema default
   applies (`applyDomainFeature`): signed out → PG; signed in where NSFW is not viewable (SFW host,
   restricted region) → PG|PG-13; otherwise uncapped.
2. **Model-gallery gates.** The model's gallery settings (Redis, JSON); the held level of a minor or
   SFW-only model (`getHeldGalleryLevel`, intersected into the level); a taken-down model's gallery is
   its owner's only (`isGalleryWithheldFrom`); pinned posts and a sponsored post on the first page.
3. **Page loop.** `getAllImages` with `limit × 2` overscan, images merged by `postId`, until `limit`
   posts or the end. Each `getAllImages` call:
   - applies the browsing-settings addons (POI / minor / tag exclusions, from system Redis or the
     defaults) and the hide-challenges tag;
   - runs one SQL query (`ImageResourceNew` → `Image` → `Post` for a model gallery), keyset-paged on
     the image id, with the viewer's own carve-outs (`OR p."userId" = <viewer>` on availability,
     `blockedFor`, POI, minor, excluded tags), cached in Redis for 10 minutes for model galleries;
   - hydrates in parallel from per-id Redis caches (msgpack): creator basic data, creator cosmetics,
     profile pictures, image frame cosmetics, event decorations, video thumbnails, tag ids, metric
     counts (watcher-fed Redis hashes in front of ClickHouse), and the viewer's own reactions
     (Postgres); Model3D link visibility. The cache reads go out in one Redis pipeline per
     dependency stage (`hydrate.Sources.Page`): every per-id key and metric hash at once, then the
     cosmetic records both cosmetic joins need; the Postgres miss reads run after it, in parallel
     (and, for the caches Node fills on read, the miss computations of §3.1);
   - drops, for anyone but a moderator, images of unpublished / scheduled posts that are not the
     viewer's own.
4. **Posts.** With `gallery-lazy-post-images` on (production), each post the page holds fewer images
   of than its row count (`getPostImageCounts`) is fetched again whole, by `postIds` in the requested
   sort, in batches of at most 25 posts / 200 rows (`packPostCompletions`), and the missing images are
   appended. Then: creators' reviews of the model, per-post fields, a per-sort ordering, wire trims;
   with lazy post images on, each post carries its first 6 images (after the Newest index sort) and
   `imageCount`, the whole post's count (`buildPostImagesWire`).
5. **Encoding.** superjson (devalue only for web bundles on pools that opt in, never for a cacheable
   response). Signed-out responses carry `public, max-age=60, s-maxage=60, stale-while-revalidate=30`.

## 2. What this service does

The same steps, in Go, for a **supported subset** of inputs — and nothing else.

**The rule:** answer only what can be answered exactly as Node would; otherwise **fall back**. A
fallback is not an error. Serving, the request is reverse-proxied to the Node app unchanged (same
path, same `Host`, same cookies). Shadowing, it is counted as `unsupported` with a reason label. The
per-reason fallback rate *is* the measured list of what is left to port, ordered by traffic.

Supported today:

| Area | Supported | Falls back |
|---|---|---|
| Input | model / version / Model3D / global feed; sorts Most Reactions, Most Comments, Most Collected, Newest, Oldest; period filters; `types`, `generation`, `withMeta`, `fromPlatform`, `disablePoi`, `disableMinor`, `hideChallenges`, `excludedTagIds`, `excludedUserIds`; cursors: on the feed-service path `feed:<a>:<b>`, `offset\|entry`, a number (an offset there); on the Postgres path a positive integer | `hidden`, user / username / collection / post / tags / tools / techniques / reactions / followed / baseModels / pending / scheduled / jumpTo / hub inputs, `include` beyond the default, Random / Recently Added sorts; cursors Node answers with a 400 (`feed-cursor:unparsed`, `feed-offset>20000`, `input-cursor` on the Postgres path) |
| Viewer | signed out; `civ-token` cookie sessions | API keys / OAuth bearer tokens, two session cookies at once, a session user not in the shared cache, verified crawlers |
| Gallery gates | settings from cache, held level, taken-down models; page-1 pinned posts (narrowed to the version, pinned-first ordering); the page-1 sponsored post (see below) | a settings key Node would rebuild; a sponsored post for a viewer whose `creator-promotions` value is unknown here (`sponsored-post`); two or more live runs on one version (`sponsored-rotation`, Node picks one at random); a failed promotion lookup (`sponsored-lookup`); a payload or gallery level this service does not read as Node does (`sponsored-data`) |
| Pages | the feed-service path (flag on) and the Postgres path (flag off); the lazy post completion on both | a failed or non-200 feed call (`feed-unavailable`, `feed-status`); a hydrate that filters out every id (`feed-hydrate-empty`) |
| Hydration | every cache hit; Postgres miss paths for basic user data, cosmetics, profile pictures, thumbnails; computed misses (§3.1) on user cosmetics, image frames and event decorations | misses on tag ids (`tag-ids-miss`) and metric hashes (`metrics-miss`); a failed miss computation (`<reason>-failed`) |
| Flags | see §8 | the index path without `FEED_SERVICE_URL` (`index-feed-unconfigured`) |

**First page of a version gallery** (`internal/feed/firstpage.go`, `promotion.go`), in the handler's
order and always on the Postgres path whatever `image-index-feed` says:

- *Pinned posts:* the version's `pinnedPosts` are fetched whole (no model scope, no cursor, the
  request's own sort, period, level and filters, 20 × 20 rows), narrowed to media the version made or
  that has no resource rows (`filterPinnedImagesToVersion`), and kept off every page by the page loop.
  They are merged with the page by ascending post id, marked `pinned`, not completed (fetched whole
  already), and sorted first under every ported sort.
- *Sponsored post* (`getSponsoredGalleryPost`): approved `galleryPromotion` placements on the model
  resolved within the last 7 days, parsed as `parseGalleryPromotionData` does, live by
  `isPromotionLive`, made for this version; served at the accept-frozen level held to the model's
  platform lock today (else the host's gallery level); fetched at `(preCap ?? level) & serving`
  (20 rows) unless it is a pinned post, with the browsing-settings addons resolved at that level
  (getAllImages resolves them per call, so they can differ from the page's), and only the
  host-approved images kept. It goes after the
  pinned posts, or second (`sponsoredSlotIndex`), with no review and no per-post index sort, and its
  post is kept off the page.

Layout:

```
cmd/feed-go          wiring, listeners, fallback proxy
internal/trpc        tRPC v11 query/response envelopes
internal/superjson   the superjson writer the client decodes
internal/auth        session JWS verification, revocation registry, cached session user
internal/browsing    level flags, domain cap, browsing-settings addons, host color, region rules
internal/feed        input parsing, the SQL, page sources, page loop, post completion, grouping and
                     ordering, gallery gates; the REST /api/v1/images port (v1query.go, v1images.go);
                     the image.getInfinite port (infinite.go)
internal/modelfeed   the model.getAll port: input, the getModelsRaw SQL, the page loop and the wire
internal/feedsvc     the image feed service: query mapper, cursor codec, HTTP client
internal/hydrate     read-only cache readers (msgpack) and miss paths; the page-cache enumeration
                     and the presence check of the Go-first probe (presence.go)
internal/shadow      the comparators (superjson envelope; plain JSON for REST) and classifiers (by
                     post id; by item id for a flat page and REST)
internal/server      HTTP handlers (the Go-first probe: probe.go), metrics
internal/fallback    the fallback error and its reasons
```

## 3. What it reuses

- **Postgres:** the same read replica the Node path reads this procedure from
  (`DATAPACKET_DATABASE_RO_URL`, falling back to `DATABASE_REPLICA_URL`). Read-only. The pool is
  bounded explicitly (`internal/dbpool`): at most `FEED_GO_DB_MAX_CONNS` connections (default 8,
  sized for the shadow workers and their hydration fan-out; see the package comment), none kept open
  when idle, a 30-minute connection lifetime and a 5-minute idle timeout. A `pool_max_conns`,
  `pool_min_conns`, `pool_max_conn_lifetime` or `pool_max_conn_idle_time` in the database URL wins.

  *Worst-case fan-out, as of 2026-11-14:* shadow concurrency is `FEED_GO_SHADOW_WORKERS` (4 in the
  deployment) comparisons; each runs its page queries one at a time, each followed by a parallel
  hydration of nine lookups of which at most eight can reach Postgres at once (basic users, cosmetics,
  profile pictures, user cosmetics, frames and event decorations on a cache miss — the last three
  each one lookup query, then at most two sequential withheld-cosmetic queries; video thumbnails; a
  signed-in viewer's reactions), then a
  3D-model read when the page has any. With lazy post images on, a comparison then runs one post-count
  query and up to `FEED_GO_COMPLETION_CONCURRENCY` (default 4, `feed.DefaultCompletionConcurrency`)
  completion fetches at once,
  each a page query plus its hydration. So the worst case is ~4 × 4 × 8 = 128 concurrent reads, and the
  common case is far fewer (page queries plus the reads that always go to Postgres). 8 covers the
  common case with headroom and makes a burst wait instead of opening 80 pooler connections per pod.
  Page 1 of a gallery with pinned posts or a sponsored post adds one sequential fetch (plus its
  hydration) for each before the page loop, which does not raise that worst case.
- **Redis (cache cluster):** the same per-id caches, read-compatibly: plain msgpack maps
  (msgpackr's module-level `pack`, `useRecords: false`), Dates as the timestamp extension, `undefined`
  as fixext type 0, `notFound` / `debounce` markers honoured, stale entries served. **By default this
  service never writes those keys** — a Go encoding bug cannot poison a cache the Node app reads.
  The cost: a miss Go computes (§3.1) stays a miss for the next reader until Node fills it.
  `FEED_GO_CACHE_WRITEBACK=true` writes what Node writes instead (§3.1). The shadow does **not**
  measure how often misses happen: a sample reaches this service after Node has answered the same
  request, so Node has just filled every key it read and the shadow almost never sees a miss.
  Serving reads first, before Node, so it needs a Go-first measurement of the miss rate (the cache
  reads alone, on requests Node has not answered) and Go-side miss filling for every cache it reads
  — §3.1 covers the image path's per-entity caches; a miss on any other (model.getAll's, §15) is
  still a fallback to Node.
- **Redis (system):** the session revocation registry and the browsing-settings addons. Reached the
  way the Node app reaches it (`packages/civitai-redis`, `getBaseClient('system')`), from the same
  env vars, so one deployment config feeds both (`internal/sysredis`):
  - `REDIS_SYS_SENTINELS` non-empty → **Sentinel mode** (go-redis `NewFailoverClient`, the library's
    Sentinel client). The comma-separated `host[:port]` list (port defaults to 26379) is asked for
    the master of group `REDIS_SYS_SENTINEL_NAME`, and the client follows that master across a
    failover. The group name is required (startup fails without it, as Node's env schema does). The
    master password comes from `REDIS_SYS_URL`, whose host is not used; `REDIS_SYS_SENTINEL_PASSWORD`,
    when set, authenticates to the Sentinels. As on Node's Sentinel branch: no TLS, no username,
    database 0. A set-but-blank or malformed list fails startup rather than falling back.
  - otherwise → one connection to `REDIS_SYS_URL` (a `rediss://` URL enables TLS; the path is ignored
    and database 0 is used, as Node connects to `protocol//host` only).
  - Known difference: Node passes the URL password as `new URL()` returns it (still
    percent-encoded); Go decodes it. Identical for passwords with no reserved characters.
- **The page query cache** is the one place keys cannot be shared: Node keys on a hash of Prisma's SQL
  fragments, which different SQL text never reproduces. Go keeps its own key space
  (`feed-go:getAllImages:v1:<sha256>`), but adds its keys to the **same** `tag:images-model…` sets,
  so the existing invalidation on image upload / update clears both services' entries at once.
- **The image feed service** (`FEED_SERVICE_URL`, the same variable and value the Node pools carry):
  `GET <base>/v1/feed?<query>` with a 5s timeout. The request-source headers follow the mode: a
  shadow compute sends `x-request-source: shadow` and `x-replay-id: feed-go-shadow` (the feed service
  labels its metrics by the replay id, so shadow load stays out of its live series); a served request
  is the site's own traffic and sends what Node's served reads send, `x-request-source: primary` and
  no replay id (`feedsvc.WithShadow` marks the shadow context). At most
  `FEED_GO_COMPLETION_CONCURRENCY` (default 4) completion fetches run at once per request: Node runs
  them all at once, and 4 is sized for shadow load; a serving deployment may want a higher value,
  since the completions sit on the request's critical path under the request budget (§6.1). The query built
  exactly as `mapSearchInputToFeedQuery(input, 'primary', 'website')` builds it (`internal/feedsvc`,
  tests pin the literal query strings). A mapper refusal Node answers with an empty page is answered
  with an empty page here too; one Node answers with a 400 falls back. The feed's ids are hydrated
  with this service's own SQL (`ids` filter, no model join, `AllTime`, statement timeout as an error)
  and put back in the feed's order. Not ported: `hydrateWithReadRescue` (an empty hydrate
  is retried on another replica this service does not reach — it falls back instead), and the
  `feed-service-degrade` breaker and last-good page (every failed call falls back).
- **ClickHouse:** not read. Metric counts come from the watcher-fed Redis hashes; a missing hash (Node
  populates it from ClickHouse) falls back (`metrics-miss`, counted in `feed_go_fallback_total` like
  every reason).

### 3.1 Cache misses this service computes

Three per-entity caches are filled on read by their `createCachedObject` lookup. In serving mode Go
runs before Node, so these misses are Go's to answer (in shadow mode Node has just filled them).
`internal/hydrate/misses.go` runs the Node lookup's own query, once per page and cache for every
missed id, and builds the entry exactly as the Node lookup builds it; the entry is then packed with
msgpackr's encoding (`internal/jspack`, whose goldens msgpackr wrote) and read back through the same
decoder as a cache hit, so a computed miss hydrates exactly as the hit Node's write would later
produce. `FEED_GO_COMPUTE_MISSES=false` restores the fallbacks.

| Reason it replaces | Cache (key) | Node source | Query here |
|---|---|---|---|
| `user-cosmetics-miss` | `userCosmeticCache` (`packed:caches:user-cosmetics:<userId>`) | `src/server/redis/caches.ts` lookupFn (dbRead), `getWithheldCosmeticIds` (`src/server/services/creator-shop-withheld.ts`, `isListingDisplayable` in `packages/civitai-shared/src/knights-shop.ts`) | the equipped, unplaced `UserCosmetic` rows on the replica; the withheld check's two queries (creator shop listings, then the `Withheld` flag of unlisted creator cosmetics) |
| `image-frame-miss` | `cosmeticEntityCaches.Image` (`packed:caches:cosmetics2:Image:<imageId>`) | the same file's lookupFn (dbWrite) and appendFn | `UserCosmetic` placed on the image, non-event cosmetic, and the withheld check over creator cosmetics: on the replica with write-back off, on the primary with it on; the appendFn join is the existing cosmetic join |
| `event-decoration-miss` | `eventDecorationEntityCaches.Image` (`packed:caches:cosmetics2:event:v2:Image:<imageId>`) | the same file's lookupFn (dbWrite) over `cosmeticCache.fetch` (dbRead) | `UserCosmetic` placed on the image, event cosmetic: replica or primary as for frames; the cosmetic records from `cosmetics2` (replica on a miss) |

Not computed: `metrics-miss` (Node populates the hash from ClickHouse, which this service does not
read), `tag-ids-miss` (the lookup joins the tag cache and the browsing-gate tag ids), and on the REST
endpoint `image-resources-miss` (Node picks a replica by write lag). `input-techniques` is an input
shape, not a cache miss: it stays an unsupported fallback.

**Write-back** (`FEED_GO_CACHE_WRITEBACK`, default off). Off, nothing is written (the tests assert the
cache is untouched), and a lagging replica read affects only the one answer it feeds. On, each
computed entry is written where and as Node's fetch writes it: the same key
(`CACHE_KEY_NAMESPACE`-prefixed outside production), msgpackr's bytes of `{...result, cachedAt}` or of
the `{[idKey]: id, notFound: true, cachedAt}` marker, the same expiry (user cosmetics a day, markers a
day; frames and event decorations a day, markers an hour, frame markers only with
`frame-cache-negative` on), and only for a miss Node writes (no key or an undecodable value; never
inside a bust's debounce window or after a failed read). Write-back needs `DATABASE_URL` (the primary,
Node's `dbWrite`; startup fails without it): the frame and event-decoration lookups, and the frames'
withheld check, then read the primary, as Node's do (`src/server/redis/caches.ts`, the two
`dbWrite.$queryRaw` lookups). That primary read is the guard against re-caching stale state: read
from a lagging replica, a frame just unequipped or withheld would be written back and served for a
day. With the primary read, a fill races an equip or unequip exactly as Node's own fill does.

`SET NX` (where Node's write is a plain `SET`) is a second, narrower guard: it never overwrites a key
that holds a value or a bust's debounce marker at write time. It does not stop a value read before a
change from landing after the change's debounce marker expired; only the primary read bounds that, to
the same window Node has. The user-cosmetics lookup reads the replica, as Node's does. The shared
caches Go already filled from the replica before this change (basic users, `cosmetics2`, profile
pictures, thumbnails) are still never written.

The golden fixtures `as-posts/cold-*` (`testdata/golden/`) carry, per reason, Node's answer and Node's
writes for a cold key, and every served fixture is run with write-back off (nothing written) and on
(exactly Node's writes). Their Node side is a hand transcription of the lookups (`gen.mjs`; only the
encoding is msgpackr itself), so they show feed-go agrees with that transcription. They do not prove
agreement with the running Node app: the shadow diffs in production are what prove parity.

## 4. Viewer identity — never another user's private data

The procedure is public, but its answer depends on the viewer: their own scheduled / blocked / POI /
minor images, private-post images, their reactions. The invariant is that a response is computed for
the authenticated viewer or for nobody.

- The viewer id comes **only** from the `sub` of a session token whose ES256 signature verifies
  against the auth hub's JWKS, with the same checks as `packages/civitai-auth/src/verify.ts`:
  algorithm pinned (never taken from the token), issuer, expiry, no `aud`, not a `swap` token,
  impersonation end time, the 90-day lineage limit. Any failure is **signed out**, never an error
  and never a guess. No header or body field can name a user.
- Revocation is the same registry read as the main app (`session:token-state`, `session:family-state`,
  `session:all`, `session:user-cut:*`), one pipelined round trip, failing **open** on a slow store,
  exactly as the app does (a revoked token can be honoured for the length of a store outage on both).
  Every fail-open is counted (`feed_go_revocation_fail_open_total`); the warning is logged at most once
  per 10 s, with the number suppressed since the previous line.
- The JWKS is refetched every `FEED_GO_JWKS_REFRESH_MS` (default 10 min, ±10% jitter), as well as on
  an unknown `kid`, so a signing key the hub removed stops verifying without a restart. A failed
  refresh — an error status, an undecodable body, or a set with no usable ES256 key — keeps the last
  good set and retries with backoff (5 s doubling, up to the interval);
  `feed_go_jwks_refresh_total{result}` counts both outcomes. Keep-last-good is bounded: once no fetch
  has returned a usable set for `FEED_GO_JWKS_MAX_STALENESS_MS` (default 3 × the interval, 30 min),
  the set is dropped and every session verifies as **signed out** (fail closed) until a fetch
  succeeds; `feed_go_jwks_stale_total` counts each drop and one error line is logged.
  *How this differs from Node:* jose's remote JWKS reloads once its cache is 10 min old and fails
  closed as soon as that reload fails, and it accepts an empty set (then rejects every token). This
  service instead keeps the last good set, an empty answer included, for up to the staleness bound.
  The reason is blast radius: a brief hub outage or a bad deploy that publishes an empty set would
  sign out every viewer here for its whole length, while the window is short enough that a key the
  hub really retired stops verifying within ~30 min. An empty set never extends the window.
- The rich session user (moderator flag, ban) is read from the shared session cache; the cached entry
  must carry the same id as the token, or the request falls back. A cleared entry falls back. A cache
  miss falls back (Node would fetch the user from the auth hub).
- The shared moderation account (`CIVITAI_MODERATION_USER_ID`, or the reserved username in any casing)
  is never a session, as in `refuseModerationAccountSession`: refused by the token's `sub` before any
  lookup, and again by the resolved user's id or username. Signed out.
- A banned user is served as signed out, but the response stays private (not edge-cacheable), as in
  `createContext`. Feature flags are the exception: Node evaluates them with the banned session's
  user, so the `creator-promotions` mirror treats that session as its own case (§8).
- Only a response computed with **no** session user gets the public cache headers. Every per-viewer
  clause binds the verified id; signed out binds `NULL`, which makes each carve-out false.
- API keys / OAuth tokens fall back: they carry scopes and change the moderator rule (`moderatorView`).
- On the public route, a request whose `Origin` (else `Referer`) host is not on the app's allow-list
  (`SERVER_DOMAIN_*` hosts and aliases, `TRPC_ORIGINS`, `NEXTAUTH_URL`; `isAcceptableOrigin`) is handed
  to the Node app before anything is computed, so it answers as it does today (401 in production for a
  cookie caller). The shadow endpoint does not apply it: Node only samples requests it already accepted.
- The shadow endpoint receives the original `Cookie` header and verifies it the same way — it never
  trusts an identity asserted by the caller.

## 5. Wire format

The client decodes with a format-sniffing union (`src/shared/utils/trpc-union-transformer.ts`): an
object payload goes to `superjson.deserialize`. This service always writes superjson:

```
{"result":{"data":{"json":{…},"meta":{"values":{"items.0.createdAt":["Date"],…},"v":1}}}}
```

- Dates are ISO strings annotated `["Date"]`; `undefined` members are dropped from `json` and
  annotated `["undefined"]` (array elements become `null`), exactly as superjson's walker does.
- `meta.referentialEqualities` is **not** written. Node emits it when one object instance appears at
  several paths (a creator's `cosmetics` array on each of their images, the post `user` that is also
  `images[0].user`). It restores object identity after decode, never a value; nothing in the client
  compares these objects by identity.
- Object key order is not reproduced for opaque values (cache entries are emitted with sorted keys);
  it is for the response's own objects. The client reads values, not order.
- One Node quirk is ported deliberately: a post's `createdAt` is
  `images.map((i) => new Date(i.sortAt)).sort()[0]`, and `Array#sort` without a comparator orders
  Dates by their **string** form (`"Fri Mar 01 2024 …"`), so it is the alphabetically first weekday,
  not the earliest instant. The value is on the wire and drives the Newest / Oldest post order, so
  parity requires it. (Fixing it is a separate, Node-side decision.)
- devalue is not written: it is only ever chosen for web bundles on opted-in pools and never for a
  cacheable response, and every reader still decodes superjson.

## 6. How traffic reaches it

**Batching is not in the way.** This procedure is already in `NEVER_BATCH_PROCEDURES`
(`src/utils/trpc.ts`): the web client always sends it alone, as
`GET /api/trpc/image.getImagesAsPostsInfinite?input=…`. (Large inputs switch to POST via
`methodOverride`; this service falls those back.) So an exact-path route can send this procedure, and
only this procedure, to the service. Two ways, not exclusive:

1. **Ingress exact-path route** (later, in the infrastructure repo), weighted. Simple, but cohorts are
   per request, not per user.
2. **A flag-gated client transport** (companion PR): when a Flipt flag is on for the user, the client
   sends this one procedure to a separate path (e.g. `/api/trpc-go/image.getImagesAsPostsInfinite`)
   instead of `/api/trpc/…`. Default OFF. The Next app rewrites that path back to `/api/trpc/…`, so with
   no ingress route the request still reaches Node — the flag can never strand a request. With the
   route in place, the flag picks per-user cohorts and is an instant kill switch.

Either way the service proxies anything it does not answer to the Node app, so routing a request to
it is never less correct than not routing it — only its share of fallbacks changes.

### 6.1 Limits on the serving path

- **Request budget.** Each computation — a served request, and a shadow sample's compute — runs under
  `FEED_GO_REQUEST_BUDGET_MS` (default 6 s), covering every Postgres, Redis and feed-service read it
  makes. An answer is all or nothing: a computation still running at the budget, or one that finished
  after it (a read that failed open on the expired context would otherwise leave a partial page), is
  the `deadline` fallback — proxied when serving, compare result `deadline` in shadow (its own result,
  so the share the budget excludes from the match rate stays visible). A client that leaves
  mid-compute is the `canceled` fallback, not a deadline, and is not proxied (nobody would read it).
- **Panics.** A panic in a computation, its errgroup workers included (`internal/safe`), is the
  `panic` fallback and `feed_go_panics_total{where="serve"}`; one anywhere in a shadow sample
  (compute or compare) is `feed_go_panics_total{where="shadow"}`, logged with its stack, and the
  sample's queue slot is released. Neither ends the process.
- **Listeners** (`server.PublicHTTPServer` / `InternalHTTPServer`): 5 s to read the headers, 64 KiB of
  headers (Node accepts 16 KiB), 120 s idle keep-alive. Public: 10 s to read the request (a GET),
  and the request budget plus 60 s to write the response, room for the Node app's answer to a
  fallback, relayed on the same connection. Internal: 60 s to read (a shadow sample is up to 32 MiB),
  30 s to write; pprof captures extend their own deadline (§10.2).
- **Fallback proxy transport** (`cmd/feed-go/proxy.go`): its own transport, idle connections kept
  3 s, below the Node app's keep-alive, whatever its server sets (Node's 5 s default unless
  configured longer), and 32 idle per host. DefaultTransport's 90 s would reuse connections Node has
  closed: Go replays a GET on a new one, a POST becomes a 502. The browser client never POSTs to this
  procedure, so the main gains are the larger idle pool and the error counter. A failure before the
  Node app's response starts is a 502 and `feed_go_fallback_proxy_errors_total{reason="upstream"}`
  (logged), or `reason="canceled"`; one mid-body aborts the response and is not counted.
- **Shutdown.** On SIGTERM, within one 15 s grace period: new shadow samples are dropped, the running
  ones are cancelled and waited for, then both listeners drain their in-flight requests, and only then
  are the replica pool and both Redis clients closed.

## 7. Parity first: shadow mode

Nothing is served from Go until the comparator says it matches. In shadow mode Node keeps serving
every request; for a sampled fraction it also sends what it saw and what it answered to this service,
which computes its own answer and compares.

**Node side (companion PR, flag-gated, default OFF):** after the response is written, for a sampled
request (a Flipt percentage flag), fire-and-forget a `POST /internal/shadow/image.getImagesAsPostsInfinite`
to the service's internal port with:

```json
{ "input": "<the raw ?input value>",
  "headers": { "cookie": "…", "host": "…", "cf-ipcountry": "…", "cf-region-code": "…",
               "x-isuk": "…", "authorization": "<present?>", "x-civitai-verified-bot": "…" },
  "node": { "json": …, "meta": … } }
```

`node` is the superjson envelope Node already produced for the response (captured where the
serializer runs, so the sample costs Node one JSON stringify of an object it already built, on the
sampled fraction only). The call has a short timeout and its failure is ignored. The internal port is
reachable only from inside the cluster.

**Go side (this PR):** `/internal/shadow/…` answers `202` immediately and compares in the background,
bounded by a queue (`FEED_GO_SHADOW_WORKERS`); a full queue drops the sample
(`feed_go_shadow_dropped_total`) rather than slowing Node. It rebuilds the request, runs the same code
path as serving, and compares decoded values:

- `json` trees structurally (object key order ignored, array order kept, numbers compared
  numerically), `meta.values` as a set (a `Date` or `undefined` on one side only is a difference the
  client would see), `meta.referentialEqualities` ignored;
- `["undefined"]` annotations applied first, as `superjson.deserialize` applies them: superjson
  writes an undefined object member as `null` plus the annotation, this service's writer omits the
  member and writes the same annotation, and `setDeep` assigns the annotated path either way, so
  both decode to the same object. (Before this, every such member — `images.*.tags` on every image,
  `images.*.thumbnailUrl` on every image without a video thumbnail, `review` on every post without
  one — was counted `missing-in-go`, and at 64 differences per comparison those artifacts also
  truncated the report before any real difference was reached.) A real `null` against an
  `undefined` is still a difference;
- each comparison gets one result: `match`, `fields` (same posts, same order, some field differs),
  `order` (same posts, different order), `membership` (different posts), `unsupported` (Go fell back,
  with its reason), `deadline` (the compute ran past the request budget, §6.1), `go_error`;
- each differing path is counted by **category** — the path with indices folded to `*`, truncated at
  opaque JSON (`metadata`, cosmetic `data`) so label cardinality is bounded by the schema:
  `feed_go_shadow_field_diffs_total{feed_endpoint="as-posts",category="items.*.images.*.stats.likeCountAllTime",kind="value"}`;
- every `feed_go_*` series carries `feed_endpoint` (`as-posts` for this procedure, `v1-images` for §13,
  `infinite` for §14, `model-getall` for §15): four values, so the label at most quadruples a family's
  cardinality;
- differing paths (never values) are logged for a sample, so a category can be traced to a field.

**Expected noise.** Go answers milliseconds after Node, so a reaction count, a metric hash refresh or
a newly published image can differ without a bug. These show up as `stats.*` value diffs and rare
`membership` diffs on page 1 of busy galleries. The comparator does not hide them; the acceptance
read separates them by category.

**Acceptance (operator's call, per category):** sustained `match` + explainable-noise categories
over a window that covers every supported shape in volume, zero `membership` / `order` diffs not
explained by timing, and a fallback rate low enough that serving is worth it.

**What shadow cannot see: serve-time cache misses.** Node fills the per-entity caches while it
answers and posts its sample only afterwards, so a shadow compute always reads warm caches. A
Go-first serve meets them as they were BEFORE Node ran: a serving trial fell back on cache misses
that the shadow fallback rate never showed. The Go-first probe (§7.1) measures that miss rate on
live traffic before any serving step.

### 7.1 Go-first probe

**Node side** (`src/server/trpc/feed-go-shadow.ts`, `probe`; flag `feed-go-gofirst-probe`, default
OFF; `FEED_GO_GOFIRST_PROBE_SAMPLE_RATE`, default 0). For a request the shadow sampler sampled — so
the probe and the comparison describe the same requests — and for that fraction of them, the route
starts, right after `beginFeedGoShadow` and BEFORE the tRPC handler runs, a fire-and-forget
`POST /internal/probe/image.getImagesAsPostsInfinite` to feed-go's internal port:

```json
{ "input": "<the raw ?input value>",
  "headers": { "cookie": "<session cookies only>", "host": "…", "cf-ipcountry": "…", … },
  "startedAt": 1763200000123.25 }
```

`headers` is exactly what a shadow sample forwards (§7: the viewer context the page depends on);
`startedAt` is the route's start on the epoch clock (`performance.timeOrigin + performance.now()`,
in ms). Bounds: the probe runs only inside a sample that already took a per-second token and an
in-flight slot; it takes its own slot under the same `FEED_GO_SHADOW_MAX_IN_FLIGHT` cap (dropped as
`dropped_overload` when none is free) and has the shadow timeout. Outcomes:
`civitai_app_feed_go_gofirst_probe_total{outcome,feed_endpoint}`.

**Go side** (`internal/server/probe.go`). `/internal/probe/<procedure>` answers 202 at once and
probes in the background, bounded by its own queue (`ProbeQueue`, as many slots as
`FEED_GO_SHADOW_WORKERS`; full → `feed_go_gofirst_dropped_total`). The probe:

1. resolves the page ids **exactly as serving would**: the same `prepare` (input, viewer, domain
   cap) and the same `feed.Serve` over the same feed service and replica — gallery gates, pinned
   and sponsored posts, the page loop and the lazy post completions included — with two swaps
   (`probeDeps`): the page hydrator is `hydrate.PresenceProbe`, and the page-query cache is
   read-only (`QueryCache.ReadOnly`). Its answer is discarded, never serialized;
2. on every hydration of a page, runs `hydrate.Sources.Presence` instead: the same reads `Page`
   sends for the same ids, read-only — GETs of the packed per-id entries (an entry is present
   exactly when `Page` would use it: a `notFound` marker or a stale entry is present, a
   `{debounce: true}` marker or an undecodable value is a miss), EXISTS (and the `_populatedAt`
   field) on the metric hashes, and, as `Page`'s stage 2, GETs of the cosmetic records the present
   user-cosmetic and frame entries name. No replica query for a miss, no reactions query, no Model3D
   visibility query, no write. Three ways it differs from a serve:
   - the cosmetic-record miss count is a **lower bound**: stage 2 can only look up the cosmetics the
     PRESENT user-cosmetic and frame entries name; a serve would also read the records named by the
     entries it computes for the misses;
   - a failed cache read (a shard down, the context ended) makes the probe report `error`, where a
     serve fails open on most of these reads (a failed GET is a miss answered from the replica or
     computed) and might have answered;
   - it does not model the serving budget: its reads are fewer and cheaper than a serve's (no miss
     queries, no hydration), so a request a serve would cut at `FEED_GO_REQUEST_BUDGET_MS`
     (`deadline`) can probe `would_serve`;
3. records the result in `feed_go_gofirst_total{feed_endpoint,result}`:
   - `would_serve`: every cache answered, or missed only where Go answers the miss itself
     (`Sources.MissReason` is `""`): from the replica (basic users, profile pictures, thumbnails,
     cosmetic records) or, with the miss computation on (`FEED_GO_COMPUTE_MISSES`, default on), by
     computing it (user cosmetics, image frames, event decorations: `hydrate.MissCaches`);
   - `would_miss`: a cache Go falls back on missed — with the computation on, tag ids or metric
     hashes (all five per-image caches above with it off) — or before hydration the session user
     (`session-cache-miss` / `-cleared`), the gallery settings (`gallery-settings-miss` /
     `-stale`) or, for `image.getInfinite`, the blocked-tag list (`blocked-tags-miss` / `-stale`);
   - `raced`: as `would_serve`, but some present entry was filled at or after the request began
     (its `cachedAt`, or a metric hash's `_populatedAt`, is at least `startedAt` −
     `RaceSkewMargin`, 100 ms): most likely by the Node request this probe races, so a Go-first
     serve would have found it missing. `feed_go_gofirst_raced_total{feed_endpoint,cache}` counts
     the probes with a raced entry per cache. Not served: it is not in the numerator of the served
     share. `would_miss` wins over it (a miss was seen anyway);
   - `unsupported`: Go falls back for any other reason (an input shape, a bearer token, a sponsored
     post it cannot decide, the request budget); the reason is on
     `feed_go_fallback_total{mode="probe"}`;
   - `error`: a store read failed (a miss it cannot tell from one), a panic
     (`feed_go_panics_total{where="probe"}`), or a malformed probe;

   and, once per probe for each cache that missed at least one id (whatever the result),
   `feed_go_gofirst_miss_total{feed_endpoint,cache}`, so the caches that block serving read in
   order of how often.

**One enumeration.** `hydrate.PageCaches` is the single list of the per-entity caches a page reads,
with the fallback reason a miss raises without a miss computation; `Sources.MissReason` clears it
for the caches the computation answers, by the computation's own list (`hydrate.MissCaches`). The
tests pin both against `Page` itself: `Presence` reads exactly the keys `Page` reads, with each
cache emptied `Page` falls back with that row's reason or answers the page, and with frame-cache-
negative off a frame `notFound` marker is a miss for both. The golden tests (which serve with the
computation on, as production does) run the probe beside serving on every fixture, and with each
cache of every served fixture emptied, and require the same verdict; the `cold-*` fixtures are
`would_serve` with their cache reported. A miss Go answers itself is still reported per cache, and
costed (below). The probe never computes a miss.

**The cost gate.** A miss Go answers itself (replica path or computed) is served, but each costs a
database query a warm cache does not. Per served probe (`would_serve`, `raced`), the probe counts
one query per page and cache with such misses, `feed_go_gofirst_db_reads_total{feed_endpoint,cache}`
(a lower bound: the user-cosmetics computation can add two withheld-cosmetic queries), over the
pages it checked, `feed_go_gofirst_pages_total{feed_endpoint}`. **These miss frequencies are
measured while Node re-warms the cache**: every probed request is also answered by Node, which
writes back what it reads. A Go-first serve with write-back OFF (`FEED_GO_CACHE_WRITEBACK`, default
off) writes nothing, so its misses recur on every Go-served request for those ids and the measured
rate understates the steady state. **Write-back must be ON before ramping past 10%.**

**Adding a procedure.** One entry in `probes` (`internal/server/probe.go`): the `feed_endpoint`
label and a `run` that resolves that procedure's ids as its serving path does, with the
`PresenceProbe` handed to it standing in for its hydrator. `image.getInfinite` is registered that
way (`probeInfinite`: `prepareInfinite` + `feed.ServeInfinite`, feed_endpoint `infinite`; before
hydration its blocked-tag list is a cache too: `blocked-tags-miss` / `-stale` →
`cache="blocked-tags"`), and the Node sampler probes its sampled requests at
`/internal/probe/image.getInfinite`. Its own go/no-go reads the same queries with
`feed_endpoint="infinite"`.

`model.getAll` (§15) is registered too (`probeModelGetAll`, feed_endpoint `model-getall`, Node
probe path `/internal/probe/model.getAll`), differently: its hydration (`hydrate.ModelPage`,
`VersionImages`, the creator memberships) falls back on every cache miss and writes nothing, so its
probe runs the serving path itself (`prepareModelGetAll` + `modelfeed.Serve`) and reports the cache
its fallback names (`model-data`, `model-tags`, `model-frames`, `model-decorations`,
`version-images`, `creator-memberships`, `user-cosmetics`, and the pre-hydration ones) as
`would_miss`. So it sees only the FIRST cold cache of a request, queries the replica as serving does
(the page query, basic users and profile pictures on a miss), and records no `raced` entries and no
DB reads: its served share is an upper bound by the race, and it has no cost figure.

**The race, and how close to request start it runs.** The probe is only meaningful if its cache
reads land before Node's fills. It is not ahead by construction: both sides start at about the same
time and run the same chain. Node: the route starts the probe POST (its bytes leave at the handler's
first await, which comes before any page read), then `createContext` (session), the gallery gates, the feed-service call, the
page query, the hydration's cache MGETs, the miss reads, and only then the cache writes. Go: receipt,
the session and gallery reads, the same feed-service call and page query, then `Presence`. So Go's
first page check lands roughly where Node's hydration starts; Node's first fill comes after its own
MGET plus a miss query, which is the margin.

`feed_go_gofirst_check_lag_seconds` is the first page cache read minus request start, to hold
against Node's time to its first fill on the same procedure (the route's hydration span). It
crosses two pods' clocks; a negative difference is recorded as 0. It shows timing only, not
whether the race was lost: that is the `raced` result. Where the probe loses the race it reads an
entry Node just filled; the entry's own fill stamp says so, and the probe is `raced`, not
`would_serve`. What the stamp cannot catch: an entry with no stamp (a frame record, a profile
picture, a watcher-fed metric hash), and a fill by another request just before ours outside the
margin (which a Go-first serve would have found anyway). Later pages of one request (the page loop,
the post completions) are checked later than the first, which makes a lost race on them likelier.

**Go/no-go for serving** (operator decision, 2026-11-15): over the same window and endpoint.

```promql
# 1. Parity: match rate of the shadow comparison >= 0.95.
sum(rate(feed_go_shadow_compare_total{feed_endpoint="as-posts",result="match"}[1h]))
  / sum(rate(feed_go_shadow_compare_total{feed_endpoint="as-posts",result=~"match|fields|order|membership"}[1h]))

# 2. Go-first served share >= 0.90: of the probes, the share Go would have answered itself
#    (`raced` is not served).
sum(rate(feed_go_gofirst_total{feed_endpoint="as-posts",result="would_serve"}[1h]))
  / sum(rate(feed_go_gofirst_total{feed_endpoint="as-posts"}[1h]))

# 3. Reported, with the decision: database reads per served page, by cache and in total.
sum by (cache) (rate(feed_go_gofirst_db_reads_total{feed_endpoint="as-posts"}[1h]))
  / scalar(sum(rate(feed_go_gofirst_pages_total{feed_endpoint="as-posts"}[1h])))
sum(rate(feed_go_gofirst_db_reads_total{feed_endpoint="as-posts"}[1h]))
  / sum(rate(feed_go_gofirst_pages_total{feed_endpoint="as-posts"}[1h]))

# How often the probe lost the race, and on which cache.
sum(rate(feed_go_gofirst_total{feed_endpoint="as-posts",result="raced"}[1h]))
  / sum(rate(feed_go_gofirst_total{feed_endpoint="as-posts"}[1h]))
topk(10, sum by (cache) (rate(feed_go_gofirst_raced_total{feed_endpoint="as-posts"}[1h])))

# What blocks (2): the caches, then the other fallbacks.
topk(10, sum by (cache) (rate(feed_go_gofirst_miss_total{feed_endpoint="as-posts"}[1h])))
topk(10, sum by (reason) (rate(feed_go_fallback_total{feed_endpoint="as-posts",mode="probe"}[1h])))

# The race margin: p50 / p99 of the first cache read after request start.
histogram_quantile(0.5, sum by (le) (rate(feed_go_gofirst_check_lag_seconds_bucket{feed_endpoint="as-posts"}[1h])))
histogram_quantile(0.99, sum by (le) (rate(feed_go_gofirst_check_lag_seconds_bucket{feed_endpoint="as-posts"}[1h])))
```

**Serve only when `match >= 0.95` AND `would_serve / all probes >= 0.90` AND the DB-reads-per-page
figure (3) is reported with the decision** (operator decision, 2026-11-15). The second denominator is
every probe, `raced`, `unsupported` and `error` included: a request Go falls back on for any reason,
or whose served verdict the race may have flattered, is not counted as served Go-first. Write-back
must be on before ramping past 10% (the cost gate above). Read `feed_go_gofirst_dropped_total` and the Node-side `dropped_overload`
beside it: a dropped probe is not in the denominator.

## 8. Flags the Node path reads, and what this service does with them

This service does not evaluate Flipt (a Go Flipt client is a follow-up). Each flag below is either
irrelevant to the DB path, mirrored by an env var, or makes the affected requests fall back while on.
The mirrors default to the fail-safe value (fall back) and must be set to the flag's real value.

| Flag | Node effect | Here |
|---|---|---|
| `image-index-feed` | feed-service pages (`getAllImagesIndex`) instead of the Postgres query; on in production | `FEED_GO_IMAGE_INDEX_FEED` (default on) + `FEED_SERVICE_URL`; both paths ported; on without a URL → fall back |
| `gallery-lazy-post-images` | post completion, then first 6 images per post + `imageCount`; on in production (enabled, 0% rollout: the no-match default is on) | `FEED_GO_LAZY_POST_IMAGES` (default on); ported on both page paths |
| `feed-service-degrade` | circuit breaker + last-good page when the feed fails | not mirrored: every failed feed call falls back here |
| `datapacket-read` | which replica the pages and the post counts read | not mirrored: this service reads its one replica (§3) |
| `creator-promotions` | sponsored post on page 1 of a model-version gallery | `FEED_GO_CREATOR_PROMOTIONS` names the flag's audience: `false` (off for everyone), `mods-testers` (the flag's rule as of 2026-11-14: off signed out, on for moderators, unknown for other signed-in users, who may be on a user-id list feed-go does not hold, and for a banned user's session, which Node still evaluates the flag for), `everyone`, or `true` / unset (fail-safe: unknown for everyone). Where the value is known the sponsored post is ported; where it is unknown, a page that would carry one falls back (`sponsored-post`) and a page that would not is served (the flag cannot change it) |
| `image-resource-use-write` | model-gallery queries read the primary | not mirrored: off in production; the replica is used |
| `image-feed-shared-users` | one `user` object per creator on the wire | decoded value unchanged; nothing to do |
| event decoration flags (flag `birthday-2026` for event `birthday2026`, …) | which event hats are visible to which viewer: `getVisibleDecorationEvents` asks the event engine and the event's Flipt flag per viewer (signed out: the flag's base; signed in: the flag for that user; a moderator session: always on) | `FEED_GO_DECORATION_EVENTS`: comma-separated event names (the event's `name`, e.g. `birthday2026`, not its flag key) whose hats Node shows to **every** viewer now, i.e. the event has started and its flag's base is on. It must name each such event: left empty while one is live, every image wearing that hat is `null` here and an object in Node (`items.*.images.*.eventDecoration` `type` diffs). After the event ends the hats stay visible (`canWearEventDecorations` includes `ended`), so the value does not change at the end date. Base off (the kill switch) → remove the event; then moderators and testers still see hats in Node and not here (a parity gap, §9) |
| `frame-cache-negative` | whether the image frame cache's notFound markers are live (read as "no frame", written for an hour on a miss) | `FEED_GO_FRAME_CACHE_NEGATIVE` (default off, as Node reads a flag it cannot evaluate): off, a marker is a miss (looked up, §3.1) and none is written, as in Node |
| `kysely-image-reactions`, `image-metrics-swr`, cache L1 switches | same results by another route | nothing to do |

## 9. Not at parity (yet)

Each item is either a fallback (correct, just not served here) or a known divergence the comparator
will show.

**Fallbacks (correct, not served):**
- every input shape in the right-hand column of the §2 table;
- a sponsored post for a viewer whose `creator-promotions` value is unknown (§8), a version with two or
  more live runs at once (Node rotates them at random per request), a failed promotion lookup, and a
  run payload whose `endsAt` is not an ISO timestamp or a host gallery level that is not a number;
- feed-service failures and non-200 answers, a hydrate that empties a page, and the cursors Node
  answers with a 400 (§3);
- cache misses on tag ids (the lookup joins the tag cache — not ported), a failed miss computation
  (§3.1, `<reason>-failed`), metric hashes (ClickHouse populate not ported, `metrics-miss`), session
  users (auth hub fetch not ported), gallery settings (rebuild not ported);
- bearer tokens, two session cookies, verified crawlers, POST (`methodOverride`) requests;
- public requests from an origin the app's allow-list does not hold (reason `origin`, see §4).

**Matched behaviour worth knowing:** a page query that runs past the 20s statement timeout answers an
empty page, as Node does, rather than falling back (which would run the same slow query a second time
on Node). A metric hash holding only the `notFound` marker is a KNOWN image with zero counts
(`statsUnknown: false`): `getImageMetricsObject` gives every id whose hash exists an entry on both
its arms, so `toImageV2Stats` only reports `statsUnknown: true` when the ClickHouse read failed and
no hash was cached — a case this service falls back on (`metrics-miss`) instead of answering.

**Divergences of the miss computations (§3.1):**
- with write-back off, the frame and event-decoration lookups read the replica; Node's read the
  primary. Within replica lag of an equip or unequip, Go can answer the previous state for that one
  request (nothing is cached). With write-back on they read the primary, as Node's do;
- a nested json member order in a written entry follows the jsonb text Postgres prints, as Prisma
  parses it for Node (the integration tests pin that order against a real Postgres); a cached record
  carried into a new entry (an event decoration's cosmetic `data`) keeps its cached order.

**Divergences the comparator will show:**
- `referentialEqualities` and opaque-object key order (not visible after decode; excluded by design);
- per-viewer event-decoration visibility: only while an event's flag base is OFF (a preview before
  launch, or the kill switch), when Node shows its hats to moderators and testers alone and this
  service, which does not evaluate Flipt, shows them to nobody. With the base on every viewer sees
  them in Node and the mirror (§8) matches. A Node pod whose Flipt client has not yet initialised
  evaluates every flag as off, so it shows hats to moderators only, while the mirror shows them to
  all; once initialised the client keeps evaluating from its last config if Flipt goes away;
- the session cookie roll: Node re-issues a session cookie older than a day; this service never sets
  cookies, so the next Node request rolls it instead;
- web-client response headers Node adds (`x-update-required`, site alerts, rate-limit headers) are not
  sent;
- the version→model lookup reads Postgres directly instead of the version-model cache (same answer,
  different staleness);
- the reviews query's tie order between two reviews with the same rating by one user (Postgres order
  is unspecified on both sides);
- `feedRequestCapture` (sampled ClickHouse logging of feed requests) is not ported — a side effect,
  not part of the answer.
- the feed service answers milliseconds after it answered Node: on a busy gallery the page can move
  between the two calls (`membership` / `order` diffs on Newest first pages).
- a model gallery with a `modelId` and no `modelVersionId` on the feed-service path is an empty page,
  as in Node (the mapper cannot express it); so are `generation`, `remixOfId`, `requiringMeta`,
  browsing level 0 and more than 100 excluded tags.
- `creator-promotions` is read from the `FEED_GO_CREATOR_PROMOTIONS` mirror, not Flipt: if the flag's
  rule changes (a widened segment, a new rollout) or a Node pod carries a `FEATURE_FLAG_*` override,
  the mirror must follow or sponsored posts diverge (`membership` diffs on page 1 of a promoted
  version). With Flipt down, Node's static fallback for this flag (`availability: ['mod']`) also
  answers on for moderators and off when signed out, so `mods-testers` still agrees.
- a run that ends, or a placement approved, between Node's lookup and this one (milliseconds apart).

## 10. Measurement plan — CPU per call, Go vs Node, same traffic

Shadow mode gives both sides the same requests. During it the Go process does nothing but handle
shadow samples, so its CPU per call is a plain ratio. Every series below carries `feed_endpoint`; add
`feed_endpoint="as-posts"` (or `"v1-images"`, §13, `"infinite"`, §14, or `"model-getall"`, §15) to each
selector to read one endpoint. The whole-process ratio cannot be split by endpoint (process CPU has no
label), so with more than one shadow on read the per-phase figure, which can. **That ratio is an UPPER
BOUND for serving:**
each shadow sample also costs work serving never does — receiving and decoding Node's envelope (up
to 32 MiB) and `shadow.Compare` parsing both answers and walking the two trees. That overhead is
in `process_cpu_seconds_total`, so a whole-process figure below Node's is conservative, and one near
Node's does not by itself show Go is no cheaper. The per-phase series below separate it out.

```promql
# Go: CPU seconds per computed answer (shadow), GC and runtime included.
sum(rate(process_cpu_seconds_total{job="feed-go"}[10m]))
  / sum(rate(feed_go_requests_total{mode="shadow",outcome="served"}[10m]))

# Share of samples Go answered itself (the rest fell back and cost almost nothing).
sum(rate(feed_go_requests_total{mode="shadow",outcome="served"}[10m]))
  / sum(rate(feed_go_requests_total{mode="shadow"}[10m]))

# What blocks serving more: fallback reasons by rate.
topk(10, sum by (reason) (rate(feed_go_fallback_total{mode="shadow"}[1h])))

# Match rate, and beside it what that denominator leaves out: the share of samples Go fell back on
# (`unsupported`) or cut at the request budget (`deadline`), with the reasons behind them.
sum by (feed_endpoint) (rate(feed_go_shadow_compare_total{result="match"}[1h]))
  / sum by (feed_endpoint) (rate(feed_go_shadow_compare_total{result=~"match|fields|order|membership"}[1h]))
sum by (feed_endpoint, result) (rate(feed_go_shadow_compare_total{result=~"unsupported|deadline"}[1h]))
  / ignoring(result) group_left sum by (feed_endpoint) (rate(feed_go_shadow_compare_total[1h]))
topk(10, sum by (feed_endpoint, reason) (rate(feed_go_fallback_total{mode="shadow"}[1h])))
```

### 10.1 Compute-only CPU: the per-phase series

Each shadow sample runs three phases, each recorded with `{phase, outcome}`:

| phase | covers | outcomes | serving pays it? |
|---|---|---|---|
| `decode` | reading the posted body and parsing the `ShadowRequest` (Node's envelope included) | `ok`, `bad_request` | no |
| `compute` | `compute`: auth, the page, hydration, `superjson.Serialize` — the answer serving returns | `served`, `fallback`, `error` | yes |
| `compare` | `shadow.Compare` (parses both envelopes, walks both trees) + `Classify` | `ok`, `bad_request` | no |

Series:

- `feed_go_shadow_phase_seconds` — wall time of every phase (histogram).
- `feed_go_shadow_phase_cpu_seconds_total` — **process** CPU (`getrusage(RUSAGE_SELF)`, user+system)
  consumed between the phase's start and end, added only when the phase was **solo**: it was the only
  shadow sample holding a queue slot when it started, no Go-first probe (§7.1) held one, and no
  sample or probe was admitted before it ended. (A probe of a request usually runs while that
  request's shadow sample is on its way, so with probes on, coverage drops.)
- `feed_go_shadow_phase_solo_total` — how many phases were counted in the CPU series (its denominator).
- `feed_go_shadow_phase_solo_wall_seconds_total` — the wall time of those same solo phases, to compare
  with the mean over every phase (the length-bias check below).

**Method, and why.** Go has no faithful per-request CPU clock: a request's work runs on several
goroutines (the hydration lookups run in parallel) that migrate across OS threads, so a thread CPU
clock misses work and a goroutine cannot be pinned without changing the program. Process CPU deltas
are exact when only one request is running, and a pod taking sampled shadow requests at a low rate
is in that regime almost all the time. So the CPU series counts only phases
no other sample overlapped, and `solo_total` says how many that was. Wall time is NOT a CPU proxy for
`compute`: it is mostly waiting on Redis, Postgres and the feed service, so apportioning process CPU by
wall-time share overstates compute; use the wall histogram for latency and as a sanity check only.

```promql
# Go CPU per SERVED call, compute only (the go/no-go figure), per endpoint.
sum by (feed_endpoint) (rate(feed_go_shadow_phase_cpu_seconds_total{phase="compute",outcome="served"}[1h]))
  / sum by (feed_endpoint) (rate(feed_go_shadow_phase_solo_total{phase="compute",outcome="served"}[1h]))

# Coverage: share of served computes that were solo (low share = the per-phase figure is a sample).
sum(rate(feed_go_shadow_phase_solo_total{phase="compute",outcome="served"}[1h]))
  / sum(rate(feed_go_shadow_phase_seconds_count{phase="compute",outcome="served"}[1h]))

# Length bias: mean wall of the solo computes over the mean wall of all of them. Near 1 = the solo
# phases are representative; below 1 = long computes are being excluded (see Limits).
(sum(rate(feed_go_shadow_phase_solo_wall_seconds_total{phase="compute",outcome="served"}[1h]))
  / sum(rate(feed_go_shadow_phase_solo_total{phase="compute",outcome="served"}[1h])))
/ (sum(rate(feed_go_shadow_phase_seconds_sum{phase="compute",outcome="served"}[1h]))
  / sum(rate(feed_go_shadow_phase_seconds_count{phase="compute",outcome="served"}[1h])))

# Shadow overhead per sample (what the whole-process ratio above over-counts).
sum by (phase) (rate(feed_go_shadow_phase_cpu_seconds_total{phase=~"decode|compare"}[1h]))
  / sum by (phase) (rate(feed_go_shadow_phase_solo_total{phase=~"decode|compare"}[1h]))

# Cross-check: CPU the phases do not account for (idle runtime, GC not inside a phase, scrapes,
# fallback samples). Should be small next to the phase CPU when coverage is high.
sum(rate(process_cpu_seconds_total{job="feed-go"}[1h]))
  - sum(rate(feed_go_shadow_phase_cpu_seconds_total[1h]))
```

**Limits.**

- *Background runtime work is attributed to whichever phase it lands in.* The GC runs concurrently:
  the collection of `compute`'s garbage may run during `compare` (which allocates heavily and so tends
  to trigger it) or after the sample, and a collection of an EARLIER sample's garbage (its decode and
  compare included) may run during this sample's `compute`. The direction of the net error is therefore
  not known from these series: a profile decides it. Bound it with the unaccounted-CPU cross-check, and with the Go GC
  series (`go_gc_*`) from the runtime collector; under real serving load the GC share is better read
  from a profile (below) than from these series.
- *Solo only.* Overlapping samples are excluded, not apportioned; if coverage is low (raised sample
  rate, a burst), the figure is a sample of the quiet periods, which can differ from loaded behaviour
  (less cache contention, no scheduler pressure).
- *Length bias.* A phase is excluded when another sample is admitted before it ends, and a longer
  phase is more likely to have that happen, so the solo phases lean short. Where a compute's CPU grows
  with its wall time (cache misses, large hydrations), the compute-only figure then reads LOW, which
  favours Go. The bias shrinks as coverage approaches 1; the length-bias query above measures it
  directly, and coverage alone does not.
- *Shadow-only process.* The method assumes the process runs nothing but shadow samples. The solo
  check sees only shadow samples, so in a deployment that also serves the public route (or proxies
  fallbacks) on the same process, that traffic's CPU lands in whichever phase it overlaps and the
  figure reads HIGH. Read it only from a shadow-only deployment.
- *Not covered:* building the synthetic request, the goroutine hand-off, and on the serving path the
  response write (`trpc.WriteResult`) and the reverse-proxy cost of a fallback. All are small next to
  `compute`; a fallback's proxy cost is Node's request, read on Node's side.
- A Prometheus scrape that lands inside a phase is charged to it (one scrape per interval, small).
- Off unix there is no process CPU clock: only the wall histogram is recorded.

### 10.2 CPU profile

With `FEED_GO_PPROF=true` the internal listener (the `FEED_GO_INTERNAL_ADDR` port, never the public
one) serves `net/http/pprof` under `/debug/pprof/`. Off by default; turning it on is an env change
and a restart. Anything the network allows to reach the internal port can then pull profiles, and a
`profile`/`trace` request holds its connection for the `seconds` it asks for (net/http/pprof moves its
own write deadline past the capture, so the internal listener's 30 s write timeout does not cut it),
so enable it for a profiling session and turn it off after. Pull a profile through
a port-forward to the pod's internal port:

```bash
go tool pprof -http=: 'http://localhost:9090/debug/pprof/profile?seconds=60'
```

A profile is the authority on where compute's CPU goes (including the GC share), and checks the
phase series: `compute` frames (`server.(*Server).compute` and below) against `shadow.Compare` and the
`ShadowHandler` body decode.

Node's side is the per-procedure CPU attribution already used to rank tRPC procedures (the same
measurement that identified this one), read over the same window for
`image.getImagesAsPostsInfinite`. To compare like with like:

- read Go's ratio only over answered requests. A fallback is NOT free for Go: one raised before the
  query (input shape, bearer token, origin) is cheap, but one raised during hydration (a tag-id,
  session or gallery miss, or a failed miss computation) comes after the page query and
  the parallel lookups, and in the post loop after earlier pages. That CPU lands in the numerator with
  no served request in the denominator, so it is a second reason Go's figure is an upper bound; read
  the fallback-reason rate beside it;
- run both reads over the same windows and compare medians across several windows, not one;
- note what Go does **not** pay yet: cache write-back (off by default), auth-hub fetches, ClickHouse
  populates of metric hashes, and model.getAll's cache misses — misses Node pays and Go falls back
  on — while Go now pays the miss computations of §3.1; `feed_go_cache_miss_total{cache,result}`
  counts them. In shadow the misses look rare because Node filled the keys moments before the sample
  was computed (§3), so their frequency is not measured here; a serving estimate must add them from
  a Go-first miss measurement;
- add the extra Redis and Postgres reads Go makes in shadow mode to the cost side when the sample
  rate is raised (shadowing doubles the read work for sampled requests, and on the feed-service path
  each sample is one more feed-service call per page and per completion batch).

The decision input is the ratio of the two CPU-per-call figures, on the same requests, at parity.
For Go, read the compute-only figure (§10.1) as the serving estimate, with its coverage beside it,
and the whole-process figure (above) as the upper bound that includes the shadow decode and compare.

## 11. Deploy prerequisites (infrastructure repo, later)

None of this is in this PR.

- **Image build:** a release tag prefix (e.g. `feed-go-v`) built by the tag-webhook pipeline. Unlike
  the Node apps, the build context is `apps/feed-go/` (a self-contained Go module, see `Dockerfile`).
  `scripts/release-app.mjs` reads the version from a `package.json`; this app has none, so it needs a
  small variant (a `VERSION` file, or a version-only `package.json` plus its lockfile importer) before
  a release can be cut. Both Dockerfile base images are already pinned by digest.
- **Workload:** a Deployment on the same pool class as the Node API pods it is compared with, two
  container ports (public 8080, internal 9090), liveness/readiness on `:9090/healthz`.
- **Services:** an internal Service for 9090 (metrics scrape + shadow posts from the Node pods); a
  public route for 8080 only when serving starts.
- **Secrets / env:** the replica URL, both Redis URLs (plus `REDIS_SYS_SENTINELS` /
  `REDIS_SYS_SENTINEL_NAME`, the same values the Node pools carry, §3), the auth issuer + JWKS URI,
  `CIVITAI_MODERATION_USER_ID` (§4), `TRPC_ORIGINS` + `NEXTAUTH_URL` (the origin allow-list, serving), the
  `SERVER_DOMAIN_*` hosts, `REGION_RESTRICTION_CONFIG`, `IMAGE_QUERY_CACHING`, the flag mirrors, and
  `FEED_SERVICE_URL` (the same value as the Node pools) with `FEED_GO_IMAGE_INDEX_FEED` /
  `FEED_GO_LAZY_POST_IMAGES` at the flags' values, and `FEED_GO_FALLBACK_URL` (the in-cluster Node
  service) once serving. `FEED_GO_FRAME_CACHE_NEGATIVE` mirrors a live flag: the deployment must set
  it to `frame-cache-negative`'s production value (and change it when the flag changes), or frame
  markers are read and written differently from Node (§8). `FEED_GO_CACHE_WRITEBACK` stays off until
  the operator decides; turning it on also needs `DATABASE_URL`, the primary (§3.1).
- **Network:** Node pods → feed-go `:9090` (shadow); feed-go → replica, both Redis (and the system
  Redis Sentinels), the JWKS endpoint, the image feed service, the primary (only with write-back on),
  and (serving) the Node service.
- **Monitoring:** a scrape of `:9090/metrics`; a dashboard of §10's queries and the shadow results.
- **Flags:** the Node-side shadow sample percentage, and later the client transport flag. Created OFF.

## 12. Remaining work to serve real traffic

Honest estimate, in order:

1. **Shadow wiring** — the Node-side sampler (companion PR) and the deployment (§11). Small; a few
   days including review.
2. **Burn down parity** — read the comparator for a week, fix the categories it surfaces. Unknown size
   by nature; expect several rounds. The SQL and hydration are ported line by line, but nothing has
   run against production data yet.
3. **Cut fallbacks that matter by volume** — in fallback-rate order (pinned and sponsored posts were
   ported on 2026-11-14; the user-cosmetics, frame and event-decoration miss paths on
   2026-11-15, §3.1). Left: tag ids and the metric-hash ClickHouse populate.
4. **Flags** — a Flipt evaluation client so the env mirrors go away (a few days).
5. **Serving** — the client transport flag PR, a small cohort, then ramp while watching error rate,
   latency and the Node-side CPU drop. A week of ramp.

So roughly three to five weeks of focused work from merge to serving a meaningful share — most of it
in step 2, which only production traffic can size. The CPU-per-call answer itself arrives earlier:
step 1 plus a few days of shadow traffic.

## 13. `GET /api/v1/images` (REST, shadow only)

The public images API: `src/pages/api/v1/images/index.ts` (`handleImagesRequest`) →
`runImageSearch` (`src/server/services/image-search.service.ts`) → `getImagesFromFeedServiceForRest`
(`image.service.ts`). Ported in `internal/feed/v1query.go` (the query) and `v1images.go` (the rest);
compared at `POST /internal/shadow/api/v1/images`. Nothing serves it publicly.

### 13.1 What the Node path does

1. **Query.** `imagesEndpointSchema` over Next's `req.query`: `limit` 0–200 (default 100), `page`,
   `postId`, `modelId`, `modelVersionId`, `imageId`, `ids`, `username`, `userId`, `period`, `sort`
   (default Most Reactions), `nsfw` (a deprecated level name or a boolean), `browsingLevel`, `tags`,
   `cursor` (always a string here), `type`, `baseModels`, `withMeta`, `requiringMeta`, `flatMeta`,
   `withTags`.
2. **Viewer.** `getApiAuthSession(whenBanned: 'anonymous')`: a session cookie or an API key; a banned
   user is no user at all. The viewer only reaches the query (POI / minor / tag carve-outs, the
   `viewerId` POI exemption on the feed, moderators skipping the visibility clauses).
3. **Paging guard.** `page * limit > 1000` without a cursor is a 429.
4. **Level.** `browsingLevel ?? nsfw ?? PG`; a restricted region is clamped to PG|PG-13. No domain cap
   (this route does not read the host).
5. **Gallery gates** (a `modelId`, `modelVersionId` or `postId`): the models the request selects by
   (`resolveImageModelIds`: the named model, the version's model, the post's version's model) —
   a taken-down one empties the page for everyone, its owner and moderators included; a minor or
   SFW-only one intersects the level with its held gallery level (empty → empty page). A version or
   post that cannot be found empties the page. The empty answer is `{ items: [], metadata: {} }`.
6. **Routing.** `ids`, `imageId`, or a `modelId` without a version take the legacy Postgres path
   (`getAllImages`); everything else asks the image feed service (`route: 'rest'`): the browsing
   addons resolved at the level (a `userId` naming the viewer keeps its tag exclusions off), a
   `username` resolved to its id, `mapSearchInputToFeedQuery(input, 'primary', 'rest')` (a `postId`
   is served in the requested sort on this caller), then the feed's ids hydrated with
   `feedHydrateQuery` (no model scope, paging or period; `disablePoi`, `disableMinor` always on;
   `include: ['tagIds', 'profilePictures']` plus `includeBaseModel`). The answer's `createdAt` is the
   row's `sortAt`.
7. **Shaping.** Per image: `getEdgeUrl(url, { original: true, type })`, the deprecated `nsfwLevel` name,
   `browsingLevel` (the image level, raised to a video thumbnail's), a public video still
   (`getPublicVideoThumbnail`: the custom thumbnail when its level is allowed, else a transcoded
   frame, skipped past the first seconds of a long video), six counts from the metric hashes,
   `username` (a cached numeric name as a string), `baseModel` (the checkpoint resource's raw
   `baseModel`, else null: `getBaseModelFromResources` as image.service.ts imports it, from
   `src/server/redis/caches.ts`, not the same-named ecosystem-group helper in
   `generation.constants.ts`) and
   `modelVersionIds` (the detected resources). Then `withoutHeldImages`: an image above its post's
   held model level is left out, whatever the request named.
8. **Body.** `res.json({ items, metadata })`, plain JSON (not superjson): `metadata` holds `nextCursor`
   (the feed's `feed:<a>:<b>`), `currentPage` / `pageSize` when paging, and `nextPage`, the request's
   own URL with `cursor` (or `page`) set, on `https://<host>` in production.

### 13.2 What is ported, and what falls back

| Area | Ported | Falls back (reason) |
|---|---|---|
| Query | every member above except those on the right, Next's `req.query` parsing (repeated keys, `Object.keys` order for `nextPage`) | `ids` (`v1-ids`) and `imageId` (`v1-image-id`) and a `modelId` without a version (`v1-model-only`): the legacy Postgres path; `tags` (`v1-tags`), `baseModels` (`v1-base-models`), `withMeta=true` (`v1-with-meta`: the meta cache is compressed, its reader is not ported), `withTags=true` (`v1-with-tags`); any value `Number()` would read differently from a plain integer (`v1-input-number`), a repeated schema key (`v1-input-duplicate`), a sort the feed does not have (`v1-sort`), `userId=0` (`v1-user-zero`), a malformed escape (`v1-query-encoding`) |
| Viewer | signed out; session cookies (the same resolver as §4); a banned session as signed out | API keys / bearer tokens (`bearer-token`); the sampler does not send them at all (§13.4) |
| Gates | withheld, held level, unknown version / post; the per-post hold on every page | a gallery settings key Node would rebuild (`gallery-settings-miss`); a held model whose settings carry no level (`v1-held-level-unset`) |
| Pages | the feed's page, its cursor, the empty-page answers (`requiringMeta`, `limit=0`, an empty feed answer) | a feed failure or a non-200 (`feed-unavailable`, `feed-status`), a refusal Node answers with a 400 (`feed-refused`, `v1-cursor`, `v1-page-limit`), a hydrate that errors or empties the page (`feed-hydrate-error`, `feed-hydrate-empty`: Node retries an empty one on another replica) |
| Hydration | basic users (cache, replica on a miss), thumbnails, metric hashes, image resources (cache), the hold's post→version and version→model caches (replica on a miss or past their TTL), a `username` on the replica | a metric hash miss (`metrics-miss`), an image-resources miss (`image-resources-miss`: Node picks a replica by write lag), a username the replica does not hold (`v1-username-miss`: Node reads the primary next) |
| Config | | no `FEED_SERVICE_URL` (`index-feed-unconfigured`), no `NEXT_PUBLIC_IMAGE_LOCATION` (`v1-image-location-unconfigured`) |

The endpoint publishes no cosmetics, frames, tags, reactions or event decorations, so this port does
not read them, and their cache misses (a fallback on the gallery procedure) cost nothing here.

### 13.3 Flags and settings

| Flag / setting | Node effect | Here |
|---|---|---|
| (no flag) | the REST route always takes the feed service when `FEED_SERVICE_URL` is set (`feedPrimaryAvailable`); `image-index-feed` is not read on this route | `FEED_SERVICE_URL` |
| `datapacket-read` | which replica the hydrate reads, and whether an empty hydrate is retried on the other one | not mirrored: an empty hydrate falls back |
| `feed-service-degrade` | breaker + last good page on a feed failure | not mirrored: a failure falls back |
| `isProd` | `nextPage` on `https://<host>`, else `http://localhost:3000` | always the production form (the shadowed app is a production build) |
| `NEXT_PUBLIC_IMAGE_LOCATION` | the edge URL prefix | the same variable |

### 13.4 The Node sampler (flag `feed-go-shadow-v1-images`, default OFF)

`src/server/trpc/feed-go-shadow.ts` (`beginV1Images` / `captureV1Images`), wired in the route's
handler. Its own Flipt flag, so the REST route is enabled separately from the gallery procedure; it
shares `FEED_GO_SHADOW_URL`, the sample rate and the in-flight cap with `feed-go-shadow`, and has its
own per-second bucket of the same `FEED_GO_SHADOW_MAX_PER_SECOND` size, so REST traffic cannot spend
the gallery's tokens. The in-flight cap is shared, though: while feed-go is slow to answer, REST
samples hold slots and the gallery's are dropped as overload
(`civitai_app_feed_go_shadow_samples_total{outcome="dropped_overload",feed_endpoint="as-posts"}`). The sampling decision is made after the handler's cheap rejects (the 400 and
429) and its bulkhead slot, and the in-flight slot and the token are taken only once the handler has
answered 200, so a sample holds nothing while the handler runs. A sampled 200 keeps a reference to the
body the handler passes to `res.json`; after the handler, from `setImmediate` and never awaited, it
POSTs

```json
{ "input": "<the raw query string>", "path": "/api/v1/images",
  "headers": { "host": "…", "cookie": "<session cookies only>", "cf-ipcountry": "…", … },
  "node": { "items": […], "metadata": { … } } }
```

A request carrying an API credential (a bearer header or `?token=`) is never mirrored, only counted
(`skipped_credential`): `metadata.nextPage` repeats the request's query, `?token=` included, and this
service would fall back on it anyway. Outcomes are counted in
`civitai_app_feed_go_shadow_samples_total{outcome,feed_endpoint="v1-images"}`; the encode counters carry
`feed_endpoint` too.

### 13.5 Comparison

`shadow.CompareJSON`: the same structural walk as §7 (object key order ignored, array order kept,
numbers numerically), with no annotation step — a Date is its ISO string on both sides, and an
undefined member is absent on both (`JSON.stringify` drops it; this service's writer, `superjson.Plain`,
does the same). Categories stop at `meta` only: `metadata` is the paging object here, so
`metadata.nextCursor` / `metadata.nextPage` keep their keys. Results classify by `items[].id`
(images, not posts): `match`, `fields`, `order`, `membership`, `unsupported`, `deadline`, `go_error`.

### 13.6 Measurement: the go/no-go is for the ported subset

The shadow samples of both endpoints share one queue, so §10.1's solo-phase method covers both;
read it per endpoint.

**Trivial answers are kept apart.** An answer computed without loading any image — a withheld or
fully held gallery, `limit=0`, a shape the feed cannot express, a feed page with no ids — costs
almost nothing on either side and would pull CPU per call down and the match rate up. It is
recorded as compute outcome `served_empty` (not `served`) and, when it matches, as result
`match_empty` (not `match`); a trivial answer that differs is still counted as its diff.

**The go/no-go figure** is CPU per non-trivial served call on the ported subset, with the match rate
over the same calls:

```promql
sum(rate(feed_go_shadow_phase_cpu_seconds_total{feed_endpoint="v1-images",phase="compute",outcome="served"}[1h]))
  / sum(rate(feed_go_shadow_phase_solo_total{feed_endpoint="v1-images",phase="compute",outcome="served"}[1h]))

sum(rate(feed_go_shadow_compare_total{feed_endpoint="v1-images",result="match"}[1h]))
  / sum(rate(feed_go_shadow_compare_total{feed_endpoint="v1-images",result=~"match|fields|order|membership"}[1h]))

# What the match rate's denominator leaves out: fell back (`unsupported`) or cut at the budget
# (`deadline`), as shares of all v1 samples, and the reasons (`deadline` is one of them).
sum by (result) (rate(feed_go_shadow_compare_total{feed_endpoint="v1-images",result=~"unsupported|deadline"}[1h]))
  / ignoring(result) group_left sum(rate(feed_go_shadow_compare_total{feed_endpoint="v1-images"}[1h]))

topk(10, sum by (reason) (rate(feed_go_fallback_total{feed_endpoint="v1-images",mode="shadow"}[1h])))
```

**What share of the route that is.** The figure above says nothing about the requests the port
cannot take. Node counts every request of the route, sampled or not and whatever the flag, by shape
class in `civitai_app_feed_go_v1_shape_total{class}`: `ported` (a shape the port answers), the
`unported_*` shapes it falls back on by construction (`ids`, `imageId`, `modelId_only`, `tags`,
`baseModels`, `withMeta`, `withTags`), `api_key`, and `non200`. The share of the route a Go service
could take is

```promql
sum(rate(civitai_app_feed_go_v1_shape_total{class="ported"}[1d]))
  / sum(rate(civitai_app_feed_go_v1_shape_total{class!="non200"}[1d]))
```

and is an upper bound: a `ported` request can still fall back on a cache miss or a feed failure
(the fallback-reason rate above). A saving read from the go/no-go figure applies to that share only.

Node's side is the route's own timer, `images_search_request_duration_seconds{route="api/v1/images"}` (wall time), and
the per-route CPU attribution over the same window.

### 13.7 Known divergences

- the hold caches: this service reads the post→version and version→model caches and, on a miss, its
  own replica (Node's lookups read theirs); a gallery-settings key is read, never rebuilt;
- the username lookup runs on this service's replica only (a miss falls back);
- `Object.keys` order of `req.query` is reproduced for `nextPage`; Next's parser and this one agree on
  plain `&`-separated `key=value` text (`+` as a space, percent-escapes), and a malformed escape
  falls back rather than guess;
- milliseconds between Node's feed call and this one: `membership` / `order` diffs on busy Newest
  pages, `stats.*` value diffs, as in §7.

## 14. `image.getInfinite` (tRPC, shadow only)

The flat image feed (`/images`, a creator's images, a post's carousel tail, a tag page):
`src/server/routers/image.router.ts` (`heavyProcedure`, input `getInfiniteImagesSchema`) →
`getInfiniteImagesHandler` (`image.controller.ts`) → `getAllImagesIndex` (the feed service) or
`getAllImages` (Postgres), then `withSharedFeedUsers`. Ported in `internal/feed/infinite.go`; compared at
`POST /internal/shadow/image.getInfinite`. Nothing serves it publicly. It reuses the gallery port's feed
client, page query, page cache, hydration (one cluster pipeline per stage, `hydrate.Sources.Page`), the
REST port's post→version / version→model readers and username lookup, the session resolver and the
domain cap.

### 14.1 What the Node path does

1. **Middleware.** The same `applyDomainFeature` cap as §1 (every public procedure runs it). The
   procedure is in `NEVER_BATCH_PROCEDURES`, so the client sends it alone.
2. **Hat Turf.** `hatSort`, `hatTurfMine`, `hideTurfHats`, `hideWornHats` are acted on only with the
   `hatTurfFeedCard` and `hatTurfFeedSorts` features on, on an unscoped feed, and when
   `getHatTurfFeedEvent` finds a live event; then the page comes from the turf rank
   (`readTurfRankPage` / `readMyTurfPage`) or is filtered by `turfHiddenIds` (`fillTurfPage`).
3. **Routing.** `requiresImageDbPath`: a `postId`, `postIds`, `collectionId`, `reactions`, `imageId`,
   `ids`, `hidden`, a `modelId` without a version, `prioritizedUserIds` with a model, or `publishedOnly`
   with a `userId` take `getAllImages`; a `hubId` always takes the feed; everything else takes the feed
   when `image-index-feed` is on.
4. **Gates** (not for a moderator): `isModelGalleryWithheld` (a taken-down model, except to its owner)
   and `getHeldGalleryLevel` (the held level of a minor or SFW-only model), both over the models the
   request selects by (`resolveImageModelIds`: the named model, the version's, the post's version's).
   Withheld, or a held level that leaves nothing: `{ items: [], nextCursor: undefined }`.
5. **One page.** No overscan, no grouping. Feed path (`getAllImagesIndex`): `prepareImageFeedRequest`
   (`enforceBlockedBrowsingTags`: blocked tag ids stripped from `tags`, all of them blocked → an empty
   page; the addon exclusions, the tag ones off on the viewer's own feed by id or by name; the
   hide-challenges tag; a `username` resolved to its id, unknown → 404), the feed query
   (`mapSearchInputToFeedQuery(input, 'primary', 'website')`, `tags` and `userIds` included), then the
   rows by `feedHydrateQuery` (no paging, period or model scope; `tags` and the creator kept). Postgres
   path: one `getAllImages` call; a post's media are ordered `i."index", i."id"` and paged on the index,
   so `nextCursor` is the look-ahead row's index (a number, `0`, or `null`).
6. **Wire.** Each image as `getAllImagesUncaptured` builds it under `stripImageForInfiniteWire` only:
   the gallery's image plus `availability`, `meta` (`null` without `metaSelect`), `baseModel`
   (undefined without `includeBaseModel`) and `judgeScore` (`null` outside a collection). Profile
   pictures only when `include` holds `profilePictures` (the handler adds `tagIds` alone). The result is
   `{ items, nextCursor, source: 'feed' }` (feed), `{ nextCursor, items, source: 'db' }` (Postgres), and
   the bare `{ items, nextCursor }` of the gates and of an all-blocked tag scope on the feed path.
7. **`withSharedFeedUsers`** (`image-feed-shared-users` and `trpc-fast-superjson-shared-refs` both on):
   equal `user` objects become one shared object. superjson writes that as a referential equality, which
   the comparator ignores; no decoded value changes, so nothing is ported.

### 14.2 What is ported, and what falls back

| Area | Ported | Falls back (reason) |
|---|---|---|
| Input | the global feed; `modelVersionId` (with or without `modelId`), `model3dId`; a `modelId` alone (Postgres); the creator scope (`userId`, `username`); the post scope (`postId`, Postgres); the tag scope (`tags`); every sort, period, browsing level, filter and cursor §2 ports, with the same cursor refusals | Hat Turf keys (`infinite-hat-turf`); `hubId`, `collectionId` and every other key in §2's right-hand column (`input-<key>`); `userId: 0` (`infinite-user-zero`: the feed and the hydrate read it differently) |
| Viewer | as §4 (signed out, cookie sessions, a banned session as signed out); the session's username for the own-feed rule | as §4 |
| Gates | withheld, held level, a version or post that cannot be found; moderators exempt | a held model whose settings carry no level (`held-level-unset`), a settings key Node would rebuild (`gallery-settings-miss`) |
| Tag scope | `system:blocked-browsing-tags` read from the cache cluster | that key absent (`blocked-tags-miss`) or not a `[{id}]` list (`blocked-tags-stale`): Node rebuilds it from the database |
| Pages | the feed's page and cursor, the empty-page answers; the Postgres page for a post or a model alone | a feed failure or non-200 (`feed-unavailable`, `feed-status`), a refusal Node answers with a 400 (`feed-cursor:unparsed`, `feed-offset>20000`), a feed cursor on the Postgres path (`input-cursor`), a hydrate that errors or empties the page (`feed-hydrate-error`, `feed-hydrate-empty`), a username the replica does not hold (`username-miss`) |
| Hydration | as §2 (the same `hydrate.Sources.Page`, profile pictures skipped without the include) | as §2 |
| Config | | no `FEED_SERVICE_URL` with the index mirror on (`index-feed-unconfigured`) |

### 14.3 Flags

| Flag | Node effect | Here |
|---|---|---|
| `image-index-feed` | the feed path for every shape `requiresImageDbPath` allows | `FEED_GO_IMAGE_INDEX_FEED` (§8) |
| features `hatTurfFeedCard`, `hatTurfFeedSorts` | the Hat Turf sorts and Show filters | not mirrored: a request carrying a hat key falls back whatever they say |
| feature `userHubs` | a hub feed | not mirrored: `hubId` falls back |
| `image-feed-shared-users` (+ `trpc-fast-superjson-shared-refs`) | one shared `user` per creator | no decoded difference; nothing to do |
| `datapacket-read` | which replica the rows read, and the empty-hydrate retry | not mirrored, as §8: an empty hydrate falls back |
| event decoration flags | as §8 (`eventDecorationViewer` is the viewer here too) | `FEED_GO_DECORATION_EVENTS`, as §8 |

### 14.4 The Node sampler (flag `feed-go-shadow-infinite`, default OFF)

The same mechanism as the gallery's (§7): `src/server/trpc/feed-go-shadow.ts` decides in `begin` (a GET
of `image.getInfinite`, unbatched, its own flag on, sampled at `FEED_GO_SHADOW_SAMPLE_RATE`), the
server transformer captures the envelope Node wrote, and `finish` posts
`{ input, headers, node }` to `/internal/shadow/image.getInfinite` after a 200, from `setImmediate`,
never awaited. It shares `FEED_GO_SHADOW_URL`, the sample rate and the in-flight cap with the other
routes and has its own per-second bucket of the same `FEED_GO_SHADOW_MAX_PER_SECOND` size, so it cannot
spend the gallery's or the REST route's tokens. The bucket isolates tokens only, not in-flight slots:
the cap is shared, so while feed-go is slow to answer, this route's samples can hold the slots and the
other routes record `dropped_overload` (read
`civitai_app_feed_go_shadow_samples_total{outcome="dropped_overload",feed_endpoint="as-posts"}` beside
this route's own rate). Outcomes are counted in
`civitai_app_feed_go_shadow_samples_total{outcome,feed_endpoint="infinite"}`, seeded at 0 for every
outcome; the encode counters carry the label too.

### 14.5 Comparison

`shadow.Compare`, the superjson comparator of §7 (annotations applied, referential equalities
ignored), classified by `shadow.ClassifyFlat`, which keys the items by image `id`: `match`, `fields`
(same images, same order), `order` (same images), `membership` (different images), plus `unsupported`,
`deadline`, `go_error`. Categories are the flat shape's: `items.*.<field>`, `items.*.user.<field>`,
`items.*.stats.<count>`, `nextCursor`, `source`, truncated at the same opaque keys (`metadata`, cosmetic
`data`, `remixOfId`).

### 14.6 Measurement

The shadow queue and §10.1's solo-phase method are shared, so the per-endpoint figures read with
`feed_endpoint="infinite"`. As in §13.6, an answer computed without loading an image row (a withheld or
held gallery, an all-blocked tag scope, a shape the feed cannot express, a feed page with no ids) is
`served_empty` / `match_empty`, kept out of the served CPU and the match rate:

```promql
sum(rate(feed_go_shadow_phase_cpu_seconds_total{feed_endpoint="infinite",phase="compute",outcome="served"}[1h]))
  / sum(rate(feed_go_shadow_phase_solo_total{feed_endpoint="infinite",phase="compute",outcome="served"}[1h]))

sum(rate(feed_go_shadow_compare_total{feed_endpoint="infinite",result="match"}[1h]))
  / sum(rate(feed_go_shadow_compare_total{feed_endpoint="infinite",result=~"match|fields|order|membership"}[1h]))

topk(10, sum by (reason) (rate(feed_go_fallback_total{feed_endpoint="infinite",mode="shadow"}[1h])))
```

### 14.7 Known divergences

- those of §9 that apply to a page of images (timing between the two feed calls, `stats.*` noise, the
  per-viewer event-decoration gap, response headers);
- the username lookup runs on this service's replica only (Node's hydrate reads the primary next);
- a post scope's `nextCursor` is the look-ahead row's raw index (`0`, or `null` when that index is
  NULL), exactly as Node's; whatever the client then does with such a cursor, both sides do the same;
- the blocked tag list is read from its cache key and memoized in-process for 30 s (single flight, an
  error never memoized), as Node's `createTtlMemo` does: a changed list reaches both within that
  window, each pod on its own clock.

## 15. `model.getAll` (tRPC, shadow only)

The model browse feed (`/models`, a creator's models, a tag's models): `src/server/routers/model.router.ts`
(`publicProcedure`, input `getAllModelsSchema`) → `getModelsInfiniteHandler` / `getModelsFeed`
(`src/server/controllers/model.controller.ts`) → `getModelsWithImagesAndModelVersions` → `getModelsRaw`
(`src/server/services/model.service.ts`). Ported in `internal/modelfeed`; compared at
`POST /internal/shadow/model.getAll`. Nothing serves it publicly. It shares the session resolver, the
domain cap, the browsing-settings addons, the gallery-settings reader and the user / cosmetic /
profile-picture / image-tag cache readers with the gallery port; its own readers are in
`internal/hydrate/models.go`.

### 15.1 What the Node path does

1. **Levels.** `applyDomainFeature` (every public procedure), then `resolveRequestBrowsingLevels`: a
   signed-in caller with no `browsingLevel` gets their saved one, then the domain cap clamps it.
2. **The loop** (`getModelsFeed`): up to three `getModelsWithImagesAndModelVersions` pages until
   `limit` items; each later page starts from the previous one's lookahead cursor. The answer's
   `nextCursor` is the cursor of the last page that had one, so a last page without a lookahead leaves
   the previous cursor in place. Hot with a base-model filter (and no query) leads page 1 with the
   official checkpoints and drops them from every page.
3. **`getModelsRaw`.** `enforceBlockedBrowsingTagsForModels`: a blocked tag name is an empty page; the
   addons' poi / minor switches and tag exclusions are resolved at the request level (the tag ones off
   on the viewer's own `username`). The query: `ModelMetric` joined to `Model`, or, with
   `base-model-feed-metrics` on and a base-model filter, one of three per-base-model paths (one base
   model drives from `ModelBaseModelMetric`; several on Newest / Oldest / Hot drive from `ModelMetric`
   with a LATERAL sum; several on the other sorts aggregate per model); every filter clause; a keyset
   cursor of `CONCAT(sort fields, '|')`, split into an equality and a strict branch under UNION ALL
   for the DESC-headed sorts. Then, for every row (the lookahead included): basic users, profile
   pictures, user cosmetics, `dataForModelsCache` (versions, hashes, and tags through
   `modelTagCache` → `tagCache`), the model frames, the paid-access gates, the visible event hats.
   Per row: the .com face, the visible versions (Published, not mature-restricted at a mature level,
   Public unless a creator is named), the badge's base models, the base-model selection, the first
   version, the excluded-tag drop.
4. **`getModelsWithImagesAndModelVersions`.** The shown versions' cached showcases
   (`imagesForModelVersionsCache`, image tags from `tagIdsForImagesCache`), held to a minor or
   SFW-only model's gallery level except for its owner (moderators exempt); the covers (on the shown
   version, else located on the replica and read from that version's cache, unless a base-model filter
   pins the card); the owners' metric-privacy defaults and, for owners with a hide flag, their Creator
   Program membership; per model: the cover hoisted, the face's images, `filterImagesForViewer`, the
   excluded-tag image filter, the imageless rule, `canGenerate`, the hidden metrics, the image cap
   (12, or the 6-image coverage slice with `getAllModelImagesSlim`) and field trim.
5. **Encoding.** superjson (devalue only for opted-in web bundles; the sampler re-encodes those).

### 15.2 What is ported, and what falls back

The ported set was chosen by the input shapes' share of the route's successful answers, read from
request logs before the port (the figures are not recorded here): base-model filters, cursors, tag
names and creators are the common shapes and are ported; a collection and Hot with a base-model filter
are the largest fallbacks; every other unsupported key is rare. A ported shape can still fall back on
a cache miss. In shadow that is not measured: the sample is computed after Node answered the same
request and filled every key it read, so the shadow's miss fallbacks undercount the misses a Go-first
read would see. Serving needs a Go-first miss measurement and Go-side miss filling first (§3).

| Area | Ported | Falls back (reason) |
|---|---|---|
| Input | every sort but Recently Added; `period` / `periodMode`; `limit`; the keyset cursor; `types`, `checkpointType`, `baseModels`, `tag` / `tagname`, `username` / `user`, `fileFormats`, `fromPlatform`, `earlyAccess`, `paidAccess`, `hidePaid`, `onSale`, `archived`, the licensing filters, `excludedTagIds`, `excludedUserIds`, `disablePoi`, `disableMinor` | `query` (Meilisearch), `collectionId`, `hidden`, `followed`, `newCreators`, `ids`, `modelVersionIds`, `status`, `needsReview`, `pending`, `supportsGeneration`, `isFeatured`, `availability`, `publishedFrom` / `publishedTo`, `poiOnly` / `minorOnly`, `page` (`input-<key>`); Recently Added (`model-sort-recently-added`); a cursor Node answers with a 400, or a date token not in Postgres' CONCAT form (`model-cursor`); a date token with a 1- or 2-digit fraction, which Node misreads (`short-fraction-cursor`); `ids` present at all, `[]` and `""` included (`input-ids`); Hot with a base-model filter (`model-official-pin`) |
| Viewer | as §4 | as §4; a signed-in request with no level (`model-level-absent`: the saved level is not read) |
| Flags | the state production runs (§15.3) | any model flag mirror off (`flag-off-state`) |
| Lookups | the tag by name and the creator by name on the replica; the blocked tag list | a creator the replica does not hold (`model-username-miss`: Node reads the primary, then 404s); the blocked list absent or unreadable (`blocked-tags-miss`, `blocked-tags-stale`) |
| Caches | basic users, profile pictures, cosmetics and tags by id on a miss (the replica); privacy defaults on a miss (`User.settings` on the replica) | misses on the model data, the model tags, the model frames, the model hats, user cosmetics, the version showcases, image tags, memberships (`model-data-miss`, `model-tags-miss`, `model-frame-miss`, `model-decoration-miss`, `user-cosmetics-miss`, `model-images-miss`, `tag-ids-miss`, `membership-miss`); a gallery-settings key Node would rebuild (`gallery-settings-miss`, `gallery-settings-stale`); a held setting with no level (`model-held-level-unset`) |

### 15.3 Flags

Only the state each flag runs in production is ported. A `FEED_GO_*` mirror below that reads off is
the `flag-off-state` fallback for every request: the off-state code paths (the 12-image cap, the
version-table base-model filter, the live coverage column, the non-member coverage audience) are not
in this service.

| Flag | Node effect | Here |
|---|---|---|
| `base-model-feed-metrics` | the per-base-model metric tables back a base-model filter (on, no rules, as of 2026-11-15) | `FEED_GO_BASE_MODEL_FEED_METRICS` (default on; off → `flag-off-state`) |
| feature `getAllModelImagesSlim` (Flipt `get-all-model-images-slim`) | 6 images per model by the coverage slice (a 100% threshold rollout as of 2026-11-15: on for every viewer) | `FEED_GO_MODEL_IMAGES_SLIM` (default on; off → `flag-off-state`) |
| `generation-coverage-next`, `generation-loading-open-to-all` | which coverage column `canGenerate` reads, and who is a member (both on as of 2026-11-15: `coveredNext`, every viewer a member) | `FEED_GO_GENERATION_COVERAGE_NEXT`, `FEED_GO_GENERATION_LOADING_OPEN_TO_ALL` (default on; either off → `flag-off-state`) |
| feature `modelMetricPrivacyReadtime` | the read-time metric privacy (`availability: ['public']`, no Flipt key: always on) | always on |
| `model-version-images-skip-tags` | which unused per-entry tags the version cache read attaches | no decoded difference; nothing to do |
| `frame-cache-negative` | frame-cache notFound markers are honoured (on) | markers honoured, as for image frames |
| event decoration flags | as §8 | `FEED_GO_DECORATION_EVENTS`, as §8 (the one event lists Model among its entities) |

### 15.4 The Node sampler (flag `feed-go-shadow-model-getall`, default OFF)

The same mechanism as the gallery's (§7): `src/server/trpc/feed-go-shadow.ts` keeps a table of the
mirrored tRPC procedures (endpoint label, compare URL, flag); `begin` samples a GET of one of them,
unbatched (`model.getAll` is in `NEVER_BATCH_PROCEDURES`), at `FEED_GO_SHADOW_SAMPLE_RATE`; the server
transformer captures the envelope Node wrote; `finish` posts `{ input, headers, node }` to
`/internal/shadow/model.getAll` after a 200, from `setImmediate`, never awaited. It shares
`FEED_GO_SHADOW_URL`, the sample rate and the in-flight cap with the other routes and has its own
per-second bucket of the same `FEED_GO_SHADOW_MAX_PER_SECOND` size. Outcomes are counted in
`civitai_app_feed_go_shadow_samples_total{outcome,feed_endpoint="model-getall"}`, seeded at 0 for every
outcome; the encode counters carry the label too.

### 15.5 Comparison

`shadow.Compare` (§7: annotations applied, referential equalities ignored), classified by
`shadow.ClassifyFlat`, which keys the items by model `id`: `match`, `fields`, `order`, `membership`,
plus `unsupported`, `deadline`, `go_error`. Categories are `items.*.<field>`, `items.*.version.<field>`,
`items.*.images.*.<field>`, `items.*.user.<field>`, `items.*.rank.<count>`, `nextCursor`, truncated at
the same opaque keys (`metadata`, cosmetic `data`, `remixOfId`). The showcase images and the version
are cache entries, emitted with sorted keys (§5).

### 15.6 Measurement

The shadow queue and §10.1's solo-phase method are shared, so the per-endpoint figures read with
`feed_endpoint="model-getall"`. An answer that loaded no model row (`limit` 0, a blocked tag name,
pages the query answered empty) is `served_empty` / `match_empty`, kept out of the served CPU and the
match rate (§13.6):

```promql
sum(rate(feed_go_shadow_phase_cpu_seconds_total{feed_endpoint="model-getall",phase="compute",outcome="served"}[1h]))
  / sum(rate(feed_go_shadow_phase_solo_total{feed_endpoint="model-getall",phase="compute",outcome="served"}[1h]))

sum(rate(feed_go_shadow_compare_total{feed_endpoint="model-getall",result="match"}[1h]))
  / sum(rate(feed_go_shadow_compare_total{feed_endpoint="model-getall",result=~"match|fields|order|membership"}[1h]))

topk(10, sum by (reason) (rate(feed_go_fallback_total{feed_endpoint="model-getall",mode="shadow"}[1h])))
```

### 15.7 Known divergences

- those of §9 that apply (timing: a model's counts or a version published between the two reads;
  the per-viewer event-decoration gap; response headers);
- cache staleness: a stale-while-revalidate entry (basic users, cosmetics, tags, version showcases)
  is served here where Node, holding the refresh lock, would read it again;
- the metric-privacy defaults are read for every row's owner (Node reads the shown models' owners):
  extra reads, the same answer;
- the creator lookup reads the replica only (Node reads the primary next);
- the blocked tag list is memoized for 30 s as Node memoizes it per pod, in the one memo image.getInfinite
  reads (`feed.BlockedTags`); the two memos refresh at different moments, so a changed list can reach
  this service and a Node pod up to 30 s apart;
- a cursor's date token is read in Postgres' own `CONCAT` form only; any other spelling dayjs accepts
  falls back;
- a cursor's date token with a 1- or 2-digit fraction (`.25`, how Postgres writes 250 ms) falls back
  (`short-fraction-cursor`): this service reads it as 250 ms, but Node's dayjs reads the digits as
  milliseconds (25 ms) and starts the next page at the wrong row. That is a Node bug, fixed on main
  by #9075 but not yet deployed; the fallback goes once the fix is deployed (the TODO on
  `cursorTimestamp`);
- `ids` falls back whenever it is present, empty included: Node reads `[]` as `[]` and `""` as `[0]`,
  both truthy, so either turns off the private-model filter;
- `canGenerate`, `isMatureRestricted` and the level constants come from `internal/modelfeed/basemodels.json`,
  generated by `scripts/feed-go-basemodels.ts` from the Node functions and held to them by
  `scripts/__tests__/feed-go-basemodels.test.ts`: a constants change that is not regenerated fails CI.
