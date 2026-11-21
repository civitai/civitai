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

Five more ports run in **shadow only** (nothing routes public traffic to them): the public REST
endpoint `GET /api/v1/images` (§13), the tRPC procedures `image.getInfinite`, the flat image feed
(§14), and `model.getAll`, the model browse feed (§15), and the REST model endpoints
`GET /api/v1/models` and `GET /api/v1/models/[id]` (§16). (`image.getInfinite`, `model.getAll` and the
two REST model endpoints each also have a public route that computes nothing unless its own serve
switch is on, default off: §14.8, §15.8, §16.8.) They share the hydration readers, the caches
(and the images ports the feed-service client), the shadow queue and the metric families, told
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
| Input | model / version / Model3D / global feed; sorts Most Reactions, Most Comments, Most Collected, Newest, Oldest; period filters; `types`, `generation`, `withMeta`, `fromPlatform`, `disablePoi`, `disableMinor`, `hideChallenges`, `excludedTagIds`, `excludedUserIds`, `tools` (images holding every listed tool: the `ImageTool` clause on every Postgres read, the positive ids as the feed query's `tools`), `techniques` (images with an `ImageTechnique` row for any listed id, likewise; the positive ids as the feed query's `techniques`, none sent when none is positive), `tags` (the blocked browsing tags stripped first, `blocked-tags-*` when that list cannot be read, only blocked ones an empty gallery; then images carrying any of the rest on every Postgres read, never cached, the positive ids as the feed query's `tags`); cursors: on the feed-service path `feed:<a>:<b>`, `offset\|entry`, a number (an offset there); on the Postgres path a positive integer | `hidden`, user / username / collection / post / reactions / followed / baseModels / pending / scheduled / jumpTo / hub inputs, `include` beyond the default, Random / Recently Added sorts; a `tools` or `techniques` entry that is not an int4 (`input-tools`, `input-techniques`: Node binds it against an integer type, and that cast is not reproduced); cursors Node answers with a 400 (`feed-cursor:unparsed`, `feed-offset>20000`, `input-cursor` on the Postgres path) |
| Viewer | signed out; `civ-token` cookie sessions, either slot or both (read in the main app's order, §4); a full-scope personal API key the app's principal cache holds (`FEED_GO_BEARER_AUTH`, §4.2) | every other API key and OAuth bearer token (§4.2), a session user not in the shared cache, verified crawlers |
| Gallery gates | settings from cache, held level, taken-down models; page-1 pinned posts (narrowed to the version, pinned-first ordering); the page-1 sponsored post (see below) | a settings key Node would rebuild; a sponsored post for a viewer whose `creator-promotions` value is unknown here (`sponsored-post`); two or more live runs on one version (`sponsored-rotation`, Node picks one at random); a failed promotion lookup (`sponsored-lookup`); a payload or gallery level this service does not read as Node does (`sponsored-data`) |
| Pages | the feed-service path (flag on) and the Postgres path (flag off); the lazy post completion on both | a failed or non-200 feed call (`feed-unavailable`, `feed-status`); a hydrate that filters out every id (`feed-hydrate-empty`) |
| Hydration | every cache hit; Postgres miss paths for basic user data, cosmetics, profile pictures, thumbnails; computed misses (§3.1) on user cosmetics, image frames, tag ids and event decorations, and with a ClickHouse reader on metric hashes | misses on metric hashes without a ClickHouse reader (`metrics-miss`); a failed miss computation (`<reason>-failed`) |
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
  `FEED_GO_CACHE_WRITEBACK=<cache>,…` writes what Node writes instead, for the caches it lists (§3.1). The shadow does **not**
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
- **ClickHouse:** read only for a missing metric hash, and only when a reader is configured from
  feed-go's own variables (`FEED_GO_CLICKHOUSE_HOST` + `FEED_GO_CLICKHOUSE_USERNAME`, §3.1; the app's
  `CLICKHOUSE_*` are never read). Metric counts come from the watcher-fed Redis
  hashes; a missing hash is computed with Node's own populate query, or without a reader falls back
  (`metrics-miss`, counted in `feed_go_fallback_total` like every reason).

### 3.1 Cache misses this service computes

The per-entity caches below are filled on read by their `createCachedObject` lookup. In serving mode Go
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
| `tag-ids-miss` | `tagIdsForImagesCache` (`packed:caches:tag-ids-for-images:<imageId>`): image.getImagesAsPostsInfinite, image.getInfinite, and model.getAll's version showcases | the same file's lookupFn (the fetch's dbRead): `getImageTagRows` (`src/server/redis/image-tag-rows.ts`), `tagCache.fetch`, `getImageTagGateIds` (`src/server/redis/image-tag-gate-ids.ts`) | the enabled `TagsOnImageDetails` rows on the replica (with write-back on too: Node's fill reads `dbRead`); the tag records from `basic-tags` (the replica's `Tag` on a miss); a Rekognition label on a WD14-tagged image kept only if Moderation, nameless, a style/subject tag (`src/libs/tags.ts`) or a tag a browsing rule can hide by — the blocked browsing tags plus every addon's `excludedTagIds` (`feed.ImageTagGate`), read only when such a row exists |
| `model-frame-miss` | `cosmeticEntityCaches.Model` (`packed:caches:cosmetics2:Model:<modelId>`): model.getAll | the Image cache's lookupFn over `'Model'` | as `image-frame-miss`, `equippedToType = 'Model'`; the same `frame-cache-negative` rule (one flag for every entity) |
| `model-images-miss` | `imagesForModelVersionsCache` (`packed:caches:images-for-model-version-2:<versionId>`): model.getAll's version showcases | `src/server/services/image.service.ts` lookupFn: `getImagesForModelVersion({modelVersionIds, imagesPerVersion: 20, db})` over `getDbWithoutLagBatch('modelVersion', ids)` (`src/server/db/db-lag-helpers.ts`) | the showcase query as that call builds it (no user, no level, no include): the owner's (or the `-1` system user's) published posts on the version, images rated, reviewed (`imageReviewedSql`), not blocked, not a ToS violation, not awaiting review or `acceptableMinor`, and no R+ image on a `modelRestricted` model; 20 per version in (post, index, id) order, the computed `hasMeta`, `hasPositivePrompt`, `onSite` and `remixOfId` columns. With write-back on it reads the primary when any version carries the lag flag a recent write set (`lag-helper:modelVersion:<id>`, as Node's batch check; a failed flag read counts as unflagged, as Node's guard fails open), else the replica; with it off the replica. The appendFn's image tags are applied on read, as for a hit |
| `model-decoration-miss` | `eventDecorationEntityCaches.Model` (`packed:caches:cosmetics2:event:v2:Model:<modelId>`): model.getAll | the Image cache's lookupFn over `'Model'` | as `event-decoration-miss`, `equippedToType = 'Model'` (and the entry's `equippedToType: 'Model'`); read only while an event is visible, as Node's `decorationsForEvents` returns before its fetch otherwise |
| `model-data-miss` | `dataForModelsCache` (`packed:caches:data-for-model-2:<modelId>`): model.getAll | `src/server/redis/caches.ts` lookupFn: a plain fetch's miss reads `getDbWithoutLagBatch('model', ids)` (`fromWrite`, the primary, is `refresh()` only) | the lookupFn's two statements on the database that decides: the versions (`ModelVersion` with the linked-VAE `RecommendedResource` subquery and `GenerationCoverage`, ordered by model and `index`) and the SHA256 model hashes (`ModelHash`); per model with a version `{modelId, hashes, tags: [], versions}`, a model with none left out and nothing written for it (`cacheNotFound: false`). With write-back on it reads the primary when any model carries the lag flag a recent write set (`lag-helper:model:<id>`, as Node's batch check; a failed flag read counts as unflagged), else the replica; with it off the replica. The appendFn's tags (below) are applied on read, as for a hit |
| `model-tags-miss` | `modelTagCache` (`packed:caches:model-tags:<modelId>`): model.getAll, asked for the models the data cache answered (the data cache's appendFn) | the same file's lookupFn (a plain fetch's `dbRead`) | `TagsOnModels` of the models on the replica (with write-back on too), `{modelId, tagIds}` in row order, a `notFound` marker for a model with none (whose data entry then keeps its own `tags`); the tag records from `basic-tags` as for a hit |
| `image-tags-miss` | `imageTagsCache` (`packed:caches:image-tags:<imageId>`): image.getInfinite with `include: ['tags']` | `src/server/redis/caches.ts` lookupFn: `readImageTagsForImages` → `listImageTagsForImages` (`packages/civitai-db-queries/src/hot-reads.db.ts`, the fetch's `kyselyRead`) | the `ImageTag` view's `imageTagCompositeSelect` columns on the replica, `score DESC, tagId ASC`, the numeric `score` and bigint vote counts read as numbers (as `@civitai/db/kysely` parses them), `lastUpvote` a Date; `{imageId, tags}` per image with a row, a `notFound` marker otherwise. ttl an hour, `staleWhileRevalidate` off (an entry is never stale). Not in `FEED_GO_CACHE_WRITEBACK`'s names: computed entries are never written (only kept in process for `recentTTL`) |
| `user-follows-miss` | `userFollowsCache` (`packed:caches:user-follows:<userId>`): image.getInfinite with `followed: true`, signed in | `src/server/redis/caches.ts` lookupFn (a plain fetch's `dbRead`) | `UserEngagement` rows of type `Follow` on the replica, no `ORDER BY` (Prisma sends none), `{userId, follows}` with the target ids in row order, a `notFound` marker (no follows) for a user with none. ttl a day, `staleWhileRevalidate` off. Not in `FEED_GO_CACHE_WRITEBACK`'s names: computed entries are never written, and not kept in process either (the viewer's own follow set, read back after they change it) |

The tag-ids values are `{imageId, tags}` with the tag ids in row order (Node's lookup has no `ORDER
BY` either; both read the same rows), `tags: []` for an image whose every tag was dropped, and the
`{imageId, notFound: true}` marker for an image with no enabled row. Where Node's gate read fails it
keeps every Rekognition label (`getImageTagGateIds` answers null); where this service cannot read the
gate (its blocked-tag list is absent or one Node would rebuild from the database) a row that needs it
fails the computation (`tag-ids-miss-failed`) instead of guessing.

**Stale tag ids.** `tagIdsForImagesCache` is stale-while-revalidate: an entry whose `cachedAt` is
older than its 8 h ttl is stale, and a bust (`bust`, which on an SWR cache is `invalidate`: the tag
edits in `src/server/services/tagsOnImageNew.service.ts` call it) backdates `cachedAt` so the entry is
stale within seconds. Node's next fetch takes the revalidation lock (`cache-lock:<key>:<id>`, `SET NX`, 10 s),
looks the id up again and writes the new value over the stale one; a fetch that finds the lock held
serves the stale entry. This service reads tag ids with the same ttl and does the same: with
write-back on it takes the same lock, recomputes an id whose lock it took and writes the value with a
plain `SET` (the stale entry is replaced, where every other write here is `SET NX`; a notFound marker
keeps `NX`, as Node's does, so it never replaces the stale value), and serves the stale entry of an
id whose lock is held; with write-back off it recomputes every stale id (nothing is written, so
there is no write to guard). Without the computation a stale entry is served, as before. The version
showcases are stale-while-revalidate too (a day's ttl, EX two days, markers a minute: `CacheTTL.xs`)
and are revalidated the same way, under the same lock key scheme.

**Metric hashes** (`metrics-miss`, `metrics:Image:<id>`, read by `getImageMetricsObject` on every
image endpoint). Node's `MetricService.fetch` (`event-engine-common/services/metrics.ts`, the pinned
submodule) fills a missing hash from ClickHouse; `internal/hydrate/imagemetrics.go` ports its miss
half. Only with a ClickHouse reader (`internal/chread`: the HTTP interface, stdlib only, every query a
GET so ClickHouse runs it read-only), configured from feed-go's OWN variables only:
`FEED_GO_CLICKHOUSE_HOST`, `FEED_GO_CLICKHOUSE_USERNAME`, `FEED_GO_CLICKHOUSE_PASSWORD`, for a dedicated
SELECT-only login. The app's `CLICKHOUSE_HOST` / `CLICKHOUSE_USERNAME` / `CLICKHOUSE_PASSWORD` are
deliberately ignored: the shared app config carries them (the app's read-write login) into feed-go's
environment, and they must never switch the reader on. Without a reader the miss falls back
(`metrics-miss`) as before.

- The query is Node's, byte for byte (`fetchFromClickhouse` over `buildPerDaySource`: `sum(total)` of
  `entityMetricDailyAgg_v2` per image and metric type, `HAVING value > 0`), in batches of 1000, as
  JSONEachRow with `output_format_json_quote_64bit_integers=0`, plus this client's own
  `cancel_http_readonly_queries_on_client_close=1` (a read the request gave up on is cancelled on
  the server instead of running on; Node never gives this read up early, its late answer fills the
  cache), with Node's per-query settings: the
  point-lookup ones (`max_threads=1`, `max_execution_time=6`, `timeout_overflow_mode=throw`) for at
  most 100 ids none of which is marked `metrics:timeout:Image:<id>`, `max_threads=1` alone when one
  is, none past 100.
- Every requested image is answered, as fetch's zero fill answers it: its summed counts, every other
  count 0, `statsUnknown: false`. A count this service cannot hold exactly (fractional, past 2^53)
  fails the lookup instead.
- The populate lock `metrics:lock:Image:<id>`: an id another process is populating is waited on,
  never queried again, for at most `FEED_GO_METRICS_LOCK_WAIT_MS` (default 500; unset, zero, negative
  or junk is the default), the hash re-read every 100 ms with the last read at the bound. One that has
  not landed by then falls back (`metrics-miss-failed`; the `metrics lock wait` span's outcome
  `exhausted`). Node's fetch waits longer (every 200 ms, up to 15 times) and answers it zeros only
  after 15 × 200 ms of sleeps, all of its caller's 3 s budget, so the caller always times out first
  and Node answers it `statsUnknown`: feed-go gives up sooner rather than hold the page for up to its
  whole lookup bound on another process's populate. The 100 ms cadence (half Node's) puts five reads
  inside the default bound where 200 ms would put two, and one wait still reads fewer times than
  Node's 15. The bound covers only that wait, which starts after this lookup's own populate of the
  ids it was free to query; that read keeps the lookup bound below. With write-back on the lock is taken (`SET NX`, 10 s), re-armed every
  5 s while the populate runs and released after (left to expire after a server timeout, whose
  capped lookup also marks its ids `metrics:timeout`, 12 h); with it off it is only read (`EXISTS`).
- Write-back on: each hash is written with `hReplaceStampedEx`, the Lua script Node evaluates (same
  text): the hash replaced whole, `_populatedAt` now (or aged to refresh soon when the event engine
  marked a recent event), 12 h, or `{notFound: '1'}` for 5 min. That populate runs detached from the
  request, as Node's un-aborted read: when the request's bound ends first the request falls back and
  the populate still fills the cache.
- Bounds: one page's lookup is bounded by `FEED_GO_CLICKHOUSE_TIMEOUT_MS` (default 2000, at most half
  the request budget, and never more than 2500 whatever either is set to); inside it, the wait on
  another process's populate lock by `FEED_GO_METRICS_LOCK_WAIT_MS` (above), and the lookup bound
  still ends that wait first when it is shorter. Node's whole read is
  bounded by `CLICKHOUSE_IMAGE_METRICS_TIMEOUT_MS` (3000) and answers `statsUnknown` past it; this
  lookup starts after feed-go's own cache read, so 2500 leaves room for what Node's budget spends
  before its populate, and a lookup Node would not have finished is never answered here. A pod sends at most
  `FEED_GO_CLICKHOUSE_MAX_IN_FLIGHT` reads at once (default 4); a read past it is refused at once.
  A failed, refused or late read falls back `metrics-miss-failed` (Node then answers those images
  from the cache, i.e. `statsUnknown: true`; Go leaves that answer to Node).
- A dedicated ClickHouse for entity metrics (the Node twin: `getImageMetricService` in
  `src/server/services/image.service.ts`). Configured from the Node app's own variables, so one secret
  feeds both runtimes: `CLICKHOUSE_METRICS_HOST` (full URL, protocol and port included),
  `CLICKHOUSE_METRICS_USERNAME`, `CLICKHOUSE_METRICS_PASSWORD` (never filled from another login), and
  only alongside the reader above (it never turns the computation on). Each request to it is bounded
  by `CLICKHOUSE_METRICS_REQUEST_TIMEOUT_MS` (default 10000); it shares the read cap's value but has
  its own slots. A populate reads it instead of the reader above only while the Flipt flag
  `image-metrics-dedicated-clickhouse` is on: the Node app's key, so one switch moves both runtimes.
  feed-go evaluates no other Flipt flag (§8): this one is read by `internal/flipt` (stdlib, the
  server's `POST /evaluate/v1/boolean` with `FLIPT_URL`, `FLIPT_FETCHER_SECRET`, `FLIPT_ENVIRONMENT`,
  entity `global`, no context: the arguments Node's global gate passes; the flag's plain on/off only, the server's evaluator is not the engine Node runs) every 5 s in the background, so a
  flip takes effect within 5 s with no restart and no request waits on Flipt. Never read yet, an
  unknown key (404) or no `FLIPT_URL` read off; any other failed read keeps the last good value (as
  Node's client keeps its last snapshot) until no read has succeeded for 10 minutes, then reads off
  (logged once per outage). The choice is made once per populate (all its
  batches go to one server). The query text and settings are unchanged, and inside the dedicated
  user's constraints (`max_threads` 1, `max_execution_time` 6, nothing else capped). A failed read
  there falls back `metrics-miss-failed` exactly as above and is never retried on the shared reader:
  a retry would put the load back on the shared server exactly when the dedicated one is down; the
  kill switch is the flag.
- The kept answer (`lookupShared`, write-back off) holds a computed count for 10 s; a reaction in that
  window is not in it (Node's own hash takes the watcher's increments; a §9 divergence).
- Not ported (cache HITS, unchanged here): the TTL slide on 10% of hits and the background refresh
  of a hash older than an hour.

`testdata/golden/metrics/populate.json` records what the real `MetricService.fetch` did on each miss
case (`gen-metrics.mjs` runs it through tsx over recording fakes: the SQL, settings, answer, and the
cache before and after); `TestMetricsMissGolden` holds Go to it with write-back on and off. Its
`locked-never-filled` case records fetch's zeros, which Node's caller never sees (its 3 s budget
ends first): Go is held to the fallback there.

Not computed: on the REST endpoint `image-resources-miss` (Node picks a replica by write lag). On
model.getAll the user-cosmetics and creator-membership misses still fall back, and the
official-models entry is read and refilled as §15.2.2 describes.

**Write-back** (`FEED_GO_CACHE_WRITEBACK`, default none). A per-cache allowlist: a comma-separated
list of the caches to write back, each named by its `cache` label of `feed_go_cache_miss_total`:

| Name | Cache (Node) | Lookup reads |
|---|---|---|
| `user-cosmetics` | `userCosmeticCache` | replica |
| `image-frames` | `cosmeticEntityCaches.Image` | primary |
| `event-decorations` | `eventDecorationEntityCaches.Image` | primary |
| `tag-ids` | `tagIdsForImagesCache` (incl. its stale revalidation and locks) | replica |
| `model-frames` | `cosmeticEntityCaches.Model` | primary |
| `model-decorations` | `eventDecorationEntityCaches.Model` | primary |
| `version-images` | `imagesForModelVersionsCache` (incl. its stale revalidation and locks) | primary for a lag-flagged id |
| `model-data` | `dataForModelsCache` | primary for a lag-flagged id |
| `model-tags` | `modelTagCache` | replica |
| `official-models` | getOfficialModelIds' entry (and its lock) | replica |
| `metrics` | the image metric hashes (MetricService's populate: locks, hashes) | ClickHouse |

e.g. `FEED_GO_CACHE_WRITEBACK=metrics,tag-ids`. Empty (the default) writes nothing. Throughout this
document "write-back on" (or "off") for a cache means that cache is (or is not) listed. A name not in
the table fails startup (a typo never silently leaves a cache unwritten); `image-meta` is computed but
never written, so it is not a name. The old bool form (`true`, `false`, `1`, `0`, …) is not
accepted: it fails startup like any unknown name. A cache not listed is never
written (no entry, lock or hash; the tests assert the cache is untouched), and a lagging replica read
affects only the one answer it feeds. For a listed cache, each computed entry is written where and as
Node's fetch writes it: the same key
(`CACHE_KEY_NAMESPACE`-prefixed outside production), msgpackr's bytes of `{...result, cachedAt}` or of
the `{[idKey]: id, notFound: true, cachedAt}` marker, the same expiry (user cosmetics a day, markers a
day; model data a day, no marker; model tags and their markers a day; frames and event decorations,
image and model, a day, markers an hour, frame markers only with
`frame-cache-negative` on; tag ids and their markers 9 h, the 8 h ttl plus its 1 h stale tail), and
only for a miss Node writes (no key or an undecodable value; never
inside a bust's debounce window or after a failed read). Listing a cache whose lookup reads the
primary (`image-frames`, `event-decorations`, `model-frames`, `model-decorations`, `version-images`,
`model-data`) needs `DATABASE_URL` (the primary, Node's `dbWrite`; startup fails without it, and the
primary pool, 4 connections, is opened only then): a listed frame or event-decoration lookup (image
and model), and the frames' withheld check, then reads the primary, as Node's do (`src/server/redis/caches.ts`, the
two `dbWrite.$queryRaw` lookups). That primary read is the guard against re-caching stale state: read
from a lagging replica, a frame just unequipped or withheld would be written back and served for a
day. With the primary read, a fill races an equip or unequip exactly as Node's own fill does.

`SET NX` (where Node's write is a plain `SET`; the one plain `SET` here is a revalidated stale
tag-ids value, above) is a second, narrower guard: it never overwrites a key
that holds a value or a bust's debounce marker at write time. It does not stop a value read before a
change from landing after the change's debounce marker expired; only the primary read bounds that, to
the same window Node has. The user-cosmetics, tag-ids and model-tags lookups read the replica, as
Node's do; the version-showcase and model-data lookups read the primary only for an id a recent
write flagged, as Node's lag-aware reads do. The
shared caches Go already filled from the replica before this change (basic users, `cosmetics2`,
`basic-tags`, profile pictures, thumbnails) are still never written.

**Write outcomes.** Every write of a listed cache is counted per key in
`feed_go_cache_writes_total{cache,result}`: `written` (the key holds the value now), `nx_lost` (a
`SET NX` found the key filled by another writer since the read; nothing written) or `error` (the
command failed; for the metric hashes it also fails the populate, as Node's does). The series exist,
at 0, for each listed cache and result from startup, and only for those. With
`FEED_GO_CACHE_WRITE_LOG_PER_MIN` (default 0: none) each write also logs a `cache write` line (`cache`,
`key`, `id` when the key has one, `result`; never the value), at most that many per (cache, result)
per minute (a token bucket like §10.3's; a line carries `suppressed`), so the keys a bad write filled
can be found and purged.

**Repeated misses** (`lookupShared`). Concurrent requests that miss the same ids of one cache share
one lookup (singleflight per cache and id set). For a cache not written back, each lookup's answer (a record,
or "no row") is also kept in process for 10 s (at most 50 000 ids; expired ones are swept at most
once a second, and while it is full of live ones a new id is not kept), so the same miss within seconds
sends no query: without a write, Node's next fill is the only thing that would otherwise end the
repeats. For a written-back cache nothing is kept (the written entry answers repeats). Every computed cache
is kept but the image meta (§13) and the user follows (§14.2: the viewer's own follow set, read back
after they change it): the tag ids, model frames, model decorations, model data, model
tags and the official models too, as none depends on the viewer
and Node already serves tag ids from a per-process copy for longer than 10 s. The kept answer is a
§9 divergence.

**Rollout order** (operator decision, 2026-11-15): `FEED_GO_COMPUTE_MISSES` on first, then
`FEED_GO_CACHE_WRITEBACK` (with `DATABASE_URL` once a primary-reading cache is listed) **before any
serving ramp past 10%**, one cache at a time, each read against its `feed_go_cache_writes_total`. Below that,
Node still serves most requests and refills these caches; past it a Go-served request's misses recur
on every Go-served request for those ids (the reason §7.1's probe miss rate understates the steady
state with write-back off). Read the ramp decision against §7.1's go/no-go queries.

The golden fixtures `as-posts/cold-*` (`testdata/golden/`) carry, per reason, Node's answer and Node's
writes for a cold key, and every served fixture is run with write-back off (nothing written) and on
(exactly Node's writes). Their Node side is a hand transcription of the lookups (`gen.mjs`; only the
encoding is msgpackr itself), so they show feed-go agrees with that transcription. They do not prove
agreement with the running Node app: the shadow diffs in production are what prove parity.

## 4. Viewer identity — never another user's private data

The procedure is public, but its answer depends on the viewer: their own scheduled / blocked / POI /
minor images, private-post images, their reactions. The invariant is that a response is computed for
the authenticated viewer or for nobody.

- The session token is read from the session cookies in the order the main app reads them
  (`readSessionToken` in `packages/civitai-auth/src/cookies.ts`, called by `getHubSession`). A
  request may carry two slots, the shared `__Secure-civ-token` and the host-only `__Host-civ-token`
  (http dev has only the bare `civ-token`). The mode for the request's `Host` is its site's
  `AUTH_SESSION_COOKIE_MODE_BY_SITE` entry (`<registrable domain>:host|shared`), else
  `AUTH_SESSION_COOKIE_MODE` (only the exact value `host` is host mode; anything else is shared). The
  order is the mode's own slot, then the other one; the shared slot is skipped altogether when the
  legacy read is off, which is a site listed `host`, or, for an unlisted site, `AUTH_LEGACY_READ` set
  to `false`, `0`, `off` or `no` (any case). A site listed `shared` always reads it.

  | Mode | Legacy read | Order read |
  |---|---|---|
  | shared | on (default) | `__Secure-civ-token`, `__Host-civ-token` |
  | host | on (default) | `__Host-civ-token`, `__Secure-civ-token` |
  | host or shared | off | `__Host-civ-token` |

  The first slot in that order the request carries with a non-empty value is the token, whatever it
  holds: presence alone decides, validity is never consulted. When that token does not verify, is
  revoked or is the moderation account, the request is **signed out**; the other slot is not tried,
  because `getHubSession` does not try it. Two valid cookies for different users therefore resolve
  to the user in the first slot read, as in Node. The `Cookie` header is read as Next's `req.cookies`
  (the `cookie` package's `parse()`) reads it: several header lines are joined with `; `, the first
  occurrence of a name wins even when its value is empty (so an empty first copy leaves that slot
  absent), a value starting with `"` loses its first and last character, and a value that does not
  URL-decode is kept raw. Each resolved session's slot is counted
  (`feed_go_session_cookie_slot_total{slot}`).
- The viewer id comes **only** from the `sub` of a session token whose ES256 signature verifies
  against the auth hub's JWKS, with the same checks as `packages/civitai-auth/src/verify.ts`:
  algorithm pinned (never taken from the token), issuer, expiry, no `aud`, not a `swap` token,
  impersonation end time, the 90-day lineage limit. Any failure is **signed out**, never an error
  and never a guess. No header or body field can name a user.
- Revocation is the same registry read as the main app (`session:token-state`, `session:family-state`,
  `session:all`, `session:user-cut:*`), one pipelined round trip bounded by `REDIS_SYS_READ_TIMEOUT_MS`
  (default 1000 ms). When that read fails (an error or the deadline) the verdict is the app's
  `createRevocationCheck` one (`packages/civitai-auth/src/revocation-check.ts`): it comes from a
  per-process record of the revocation markers this service has already read
  (`internal/auth/markers.go`, a port of `revocation-marker-cache.ts`). A marker seen here still denies
  (`deny_cached`, signed out); a session with no known marker is allowed (`allow_unknown`), because the
  record is not a replica and signing everyone out during a store outage is not the policy. The record
  keeps a token/family state only when it is `invalid` and a cut-off whenever it has a value, deletes an
  entry when a later read finds it gone, records nothing from a failed command (but does record the
  commands that answered in a round trip where another failed), and is bounded at 20 000 entries, least
  recently used evicted first, with no time-based expiry (`REVOCATION_MARKER_CACHE_MAX_ENTRIES`; a held
  marker only revokes tokens signed before it, so keeping it longer cannot deny a session the store would
  allow). `SESSION_REVOCATION_CACHE=off|0|false` turns the record off (plain fail-open), as in the app.
  Each failed read is counted by verdict (`feed_go_revocation_degraded_total{verdict}`, the app's
  `session_revocation_degraded_total`); the warning is logged at most once per 10 s, with the number
  suppressed since the previous line.
  *How this differs from Node:* the app can also put the read behind its own read breaker
  (`REDIS_SYS_READ_BREAKER_ENABLED`, default off), which refuses the read without waiting once tripped.
  That is not ported: an open breaker gives the same verdict as a failed read (from the record), so it
  changes how long a failed read takes, not what it answers. Each process holds its own record, here as in
  the app, so feed-go and a Node pod can differ on a revocation only one of them has read.
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
- API keys are resolved as the app resolves them when `FEED_GO_BEARER_AUTH` is on (default off), and
  only where the app's answer is decided by data this service reads at the same freshness: §4.2.
  Everything else, OAuth tokens included, falls back. Off, every API credential falls back
  (`bearer-token`).
- On the public route, a request whose `Origin` (else `Referer`) host is not on the app's allow-list
  (`SERVER_DOMAIN_*` hosts and aliases, `TRPC_ORIGINS`, `NEXTAUTH_URL`; `isAcceptableOrigin`) is handed
  to the Node app before anything is computed, so it answers as it does today (401 in production for a
  cookie caller). The exception is the app's own: a request whose API key resolves to a session is
  accepted from any origin (`isBearerAuth`, `src/server/createContext.ts:45-46`). Such a request is
  resolved first, inside the serve slot, and computed only when the key resolved to a viewer (§4.2);
  a key that resolves to no session is held to the origin like a cookie caller (`origin`). The
  shadow endpoint does not apply it: Node only samples requests it already accepted.
- The shadow endpoint receives the original `Cookie` header and verifies it the same way — it never
  trusts an identity asserted by the caller.

### 4.1 The minor content visibility rule

The Node image reads apply one rule (`minorMatureImageVisibleSql` and `isMinorMatureImage` in
`src/server/common/image-visibility.ts`, the rating test `minorContentRestrictedSql` /
`isMinorContentRestricted`): an image whose `minor` flag is set (`COALESCE(minor, false)`) and whose
`nsfwLevel` is NULL, 0 or at least R is shown only to its owner (`i."userId"` = the viewer) and to
moderators, whatever the viewer's browsing settings (`disableMinor` is a separate, older clause and
does not replace it). With no viewer it is shown to nobody. This service applies it on every read that
serves a Node read applying it, through one set of helpers in `internal/hydrate/minormature.go`:

| Go read | Node read | How |
|---|---|---|
| `feed.ImagesQuery.Build`: every image page of the gallery, `image.getInfinite` and `GET /api/v1/images` (Postgres pages, post completions, pinned and sponsored posts, the hydrate of the feed service's ids, the legacy `ids` batch) | `getAllImagesUncaptured` (`minorMatureImageVisibleSql({ userId: ownerId, isModerator })`) | `MinorMatureImageVisibleSQL` in the WHERE clause, after the `disableMinor` clause as in Node: the viewer's own images exempt, signed out exempting no one, `TRUE` for a moderator |
| the showcase cache's miss lookup (`sqlVersionImages`) | `imagesForModelVersionsCache`'s lookupFn (`getImagesForModelVersion` with no user) | `MinorMatureImageHiddenSQL`: the rule with no viewer |
| `hydrate.Sources.VersionImages` (`model.getAll`'s showcase images and covers) and `GET /api/v1/models`' showcase read | `imagesForModelVersionsCache`'s appendFn (`!isMinorMatureImage(i)`), on every read | `WithoutMinorMatureImages`, before the image tags are read and before any hold or per-viewer filter: for every viewer, owners and moderators included, since the cache is shared between viewers (an entry cached before the lookup left an image out still holds it) |

The feed service's index is not what applies it: Node's query mapper sends the feed only
`excludeMinor` (for `disableMinor`), so the feed can name such an image, and Node drops it in the
hydrate, which reads through `getAllImagesUncaptured`. The hydrate here is `Build` with the feed's ids,
so it drops it the same way. `model.getAll`'s cover is picked from the filtered showcase images, and a
cover located on another version is read from the same filtered cache, so a restricted cover is no
cover. Node keeps the `minor` member on these wires (it removes it only on article, bounty and webhook
payloads, which this service does not serve), and so does this service.

Reads that do not apply it, each for its own reason: the post image count (`getPostImageCounts`, an
upper bound before any visibility filter), the cover locate step (it reads a cover's post and version,
not the image), the image meta and video thumbnail lookups (of images a filtered read already chose)
and profile pictures (Node's profile-picture reads do not apply it). `TestMinorMatureCallSites`
(`internal/hydrate`) holds the ledger of every source file that reads Image rows or the showcase cache
or calls the rule, so a new read fails it until it applies the rule or says why it need not. On these
paths a signed-out viewer is already held to PG (the tRPC domain cap) or has every minor image removed
(`GET /api/v1/images` always sets `disableMinor`), so signed out the rule changes no answer today; it is
applied all the same.


### 4.2 API keys (`Authorization`), `FEED_GO_BEARER_AUTH`

On the three tRPC procedures (`image.getImagesAsPostsInfinite`, `image.getInfinite`, `model.getAll`)
an API key is resolved as `resolveSession` (`src/server/auth/get-server-auth-session.ts`) resolves it,
in this order (`internal/auth/bearer.go`). "Signed out" is the app's null session: served as for an
anonymous visitor (public cache headers, the origin check applies). "Fallback" is the request handed to
the Node app unchanged, with the reason on `feed_go_fallback_total`.

| # | The app's rule (file:line) | Here |
|---|---|---|
| 1 | The token is `authorization.split(' ')[1]`, whatever the scheme; a header with no second part (or an empty one) gives no token and the `?token=` key is then not read (`request-bearer-token.ts:9`) | the same split; no token → the cookies are read as §4 |
| 2 | Without the header, the first `?token=` value is the token unless it is the webhook token (`request-bearer-token.ts:10-14`) | fallback `bearer-query-token` (the webhook token is not known here) |
| 3 | A token, valid or not, decides the session: the cookies are never read (`get-server-auth-session.ts:67-85`) | the same: a key that signs out, or falls back, never yields to a cookie |
| 4 | A key containing `:` (a provider download token) is no session, without a lookup (`bearer-token.ts:77`) | signed out |
| 5 | The orchestrator service token is no session, without a lookup (`bearer-token.ts:80`, `orchestrator-service-token.ts:13-18`) | signed out, compared as digests against `ORCHESTRATOR_SERVICE_TOKEN` |
| 6 | The row is found by `generateSecretHash(key.trim())`, SHA-512 hex of key + `NEXTAUTH_SECRET` (`bearer-token.ts:81`, `packages/civitai-auth/src/secret-hash.ts:24`) | the same hash (`NEXTAUTH_SECRET`; unset → `bearer-unconfigured`); a key with a byte outside printable ASCII → `bearer-malformed` (Node reads the header as latin-1 and trims Unicode space) |
| 7 | The row comes from the principal cache when it holds a live entry, else from the PRIMARY database (`bearer-token.ts:88-117`; `api-key-principal-cache.ts:115-137`) | the cache only: absent, a read error or an undecodable value → `bearer-key-cache-miss` (an unknown key is always this: the cache holds only known keys) |
| 8 | A revocation tombstone `{revoked: true}` reads the primary (`api-key-principal-cache.ts:129`) | `bearer-key-revoked` |
| 9 | Only a key with `clientId === null` and type `User` or `System` is served from the cache; anything else (OAuth `Access` tokens, `Refresh`, a missing `clientId`) reads the primary (`api-key-principal-cache.ts:87-92,133`; allow-list `bearer-token.ts:96`) | `bearer-key-uncacheable` |
| 10 | An entry is live while `expiresAt` is null or not before now; else the primary, which also refuses an expired key (`api-key-principal-cache.ts:94-95,133`; `bearer-token.ts:97`) | live only with at least 5 s to spare (`BearerClockMargin`: the app's pod reads its own clock); else `bearer-key-expiry` |
| 11 | The scope is `BigInt(tokenScopeWide ?? tokenScope)` (`packages/civitai-auth/src/token-scope.ts:184`) | the same; a value `BigInt` would not read as an integer → `bearer-key-cache-shape` |
| 12 | A key holding a client-credentials-only bit (`AppStoreCatalogWrite`, `DownloadLink`) is no session on these routes (`bearer-token.ts:120`) | signed out |
| 13 | `lastUsedAt` is written (fire-and-forget) when the cached value is null or more than an hour old (`bearer-token.ts:125-130`, `api-key-principal-cache.ts:200-216`) | `bearer-last-used`: this service writes no row. Within the hour (minus the 5 s margin) the app writes nothing either |
| 14 | The user is the shared session cache entry `session:data2:<userId>`, else the auth hub (`bearer-token.ts:40`, `packages/civitai-auth/src/session-client.ts:192-196`) | the §4 session read: a miss `session-cache-miss`, a cleared entry `session-cache-cleared`, another id `session-id-mismatch` |
| 15 | A banned user (`bannedAt` truthy) is no session (`bearer-token.ts:47`) | signed out (so, unlike a banned cookie session, the response is public, as the app's `cacheable` is) |
| 16 | The moderation account, by id or username, is no session (`bearer-token.ts:48`) | signed out |
| 17 | A system account (`meta.systemAccount` truthy) with any scope bit outside `ReadOnly` reads its moderator access from the primary (`bearer-token.ts:52-66`) | `bearer-system-account` |
| 18 | The app does not check `deletedAt`: a deleted user is one the hub does not know (rule 14) | the same: a cached entry is served |
| 19 | Only a full-scope (`tokenScope === Full`) personal `User` key with no OAuth client gives a cookie session's views: moderator rights (`withModeratorRightsFor`), the owner and moderator feed views (`credentialViews`, `moderatorView`, `galleryOwnerId`) and the per-procedure scope pass (`enforceTokenScope`) (`full-user-credential.ts:18-24,39-46,63-71`; `enforce-token-scope.ts:130`; `createContext.ts:94`) | served as that user, moderator flag kept; any other key (a `System` key, a scoped key, Full plus an opt-in bit) → `bearer-scoped-key`, because the ported feeds do not model a viewer without the owner view |
| 20 | A key that resolved to a session is accepted from any origin (`createContext.ts:45-46`) and is not edge-cacheable (`createContext.ts:60`) | the same (§4, origin) |

Signed-in answers carry no public cache headers, as for a cookie session. Nothing is written: no
principal-cache fill (the app fills it on its next read), no `lastUsedAt`, no claim key.

**What still falls back, and why.**
- A key the principal cache does not hold: the app reads the primary database. The cache keeps a key
  for 30 s after the app last read it, so a key in steady use is mostly held; a cold one is not.
- The hourly `lastUsedAt` write, a system account's write key, OAuth tokens (never cached), and every
  scoped key (rule 19).
- `?token=` (the webhook token), several `Authorization` header lines (Node keeps the first, a proxy in
  between may not), and a key with a byte outside printable ASCII.
- The REST routes (`/api/v1/images`, `/api/v1/models`, `/api/v1/models/[id]`) keep every API
  credential a `bearer-token` fallback: `PublicEndpoint` shapes the cache headers on whether a
  credential was presented, `/api/v1/images` applies `REST_SCOPE_ENFORCE`, and the models routes have
  their own block-scope middleware, none of it ported. The sampler never sends a credential, and the
  model routes' public serve path (§16.8) hands every credentialed request (an Authorization header of
  any value, or `?token=`) to the Node app before anything is computed.
- Shadow and probe samples: the sampler forwards `authorization: present`, never the key, so a sample's
  API credential stays `bearer-token` (`auth.WithRedactedCredentials`).

**Residual, stated.** `ORCHESTRATOR_SERVICE_TOKEN` must be the app's value: unset here while set in the
app, that token would be looked up as an ordinary key (rule 5). It is not an issued API key, so the
principal cache holds no entry under its hash and the lookup falls back; the residual is only a service
token equal to a user's API key. The clock margin (rules 10, 13) narrows, but by its nature cannot
remove, a decision the app's pod makes a few seconds differently.

## 5. Wire format

The client decodes with a format-sniffing union (`src/shared/utils/trpc-union-transformer.ts`): an
object payload goes to `superjson.deserialize`, a string one to `devalue.parse`. This service writes
superjson unless `TRPC_WRITE_DEVALUE` is on (§5.2):

```
{"result":{"data":{"json":{…},"meta":{"values":{"items.0.createdAt":["Date"],…},"v":1}}}}
```

- Dates are ISO strings annotated `["Date"]`; `undefined` members are dropped from `json` and
  annotated `["undefined"]` (array elements become `null`), exactly as superjson's walker does.
- `meta.referentialEqualities` is **not** written. Node emits it when one object instance appears at
  several paths (a creator's `cosmetics` array on each of their images, the post `user` that is also
  `images[0].user`). It restores object identity after decode, never a value; nothing in the client
  compares these objects by identity.
- Object key order is reproduced: the response's own objects are built in Node's order, and a cached
  record the answer carries (a profile picture and its `metadata`, a cosmetic's `data`, an event
  decoration, a model's shown version and its showcase images) is read with the key order its msgpack
  bytes hold (`hydrate.Entry.Ordered`, JS own-key order: array-index keys first), which is the order
  of the Node object that wrote it. The client reads values, not order; the order is what makes the
  devalue bytes equal Node's. A record built from a replica row on a miss that is not computed into
  the cache (`profilePicturesFrom` / `cosmeticsFrom`'s replica read) still decodes its json columns into
  Go maps, so their nested keys are sorted.
- One Node quirk is ported deliberately: a post's `createdAt` is
  `images.map((i) => new Date(i.sortAt)).sort()[0]`, and `Array#sort` without a comparator orders
  Dates by their **string** form (`"Fri Mar 01 2024 …"`), so it is the alphabetically first weekday,
  not the earliest instant. The value is on the wire and drives the Newest / Oldest post order, so
  parity requires it. (Fixing it is a separate, Node-side decision.)

### 5.1 Input keys

zod strips an input key its schema does not have, so for Node an unknown key is absent. Here a key
outside the schema **falls back** (`input-unknown-key`) instead. A key the app later adds to a schema
is one it reads, and a Go build that does not know the key must not answer as though it were absent.
That holds even when the app's deploy runs ahead of this service's.

- **The allow-list is generated.** `scripts/feed-go-input-schemas.ts` projects the schemas the routes
  parse with `z.toJSONSchema` (`io: 'input'`) into `internal/inputschema/schemas.json`: each schema's
  top-level keys, and the defaults the projection carries. The schemas are
  `getInfiniteImagesSchema` (both image procedures), `getAllModelsSchema` with the router's `page`
  (`model.getAll`), and `imagesEndpointSchema` (`/api/v1/images`, moved to
  `src/server/schema/images-endpoint.schema.ts` so it can be loaded without the route).
  `scripts/__tests__/feed-go-input-schemas.schema-drift.test.ts` fails when the file is stale.
- **Every schema key is classified.** Each parser lists the keys it reads, the ones it falls back on
  (`input-<key>`), and the ones it knowingly ignores. `TestInputKeyLedger` (in `feed` and `modelfeed`)
  fails when that union differs from the schema's keys in either direction, so regenerating after a
  schema change forces the new key to be ported, made a fallback, or ignored on purpose.
- **Defaults** are read from the file: limit, sort, period and periodMode for the image procedures,
  sort, period and periodMode for `model.getAll` (its limit, 100, is the handler's), and period and
  sort for `/api/v1/images`. Its limit is not in the projection (`numericString`'s preprocess hides it)
  and is the same `galleryFilterDefaults.limit` as the image schema's. Tests pin each default as a
  literal, so a changed default is reviewed, not silently adopted. Each parser decodes them once,
  at package init, so a file without one fails at startup, never on a request.
- **The unknown-key check runs after the known fallbacks.** A request carrying an unported key
  (`input-<key>`, or on `/api/v1/images` the `v1-image-id` / `v1-tags` / `v1-base-models` shapes) and an
  unknown key too falls back under the unported key's reason, so the reason counts keep naming the
  parity gap.
- **Allowed without being schema keys:** for tRPC, `authed` (added by `authedCacheBypassLink` to every
  object input when signed in) and `direction` (added by an infinite query). The site client sends
  both and zod strips both. For `image.getInfinite` only, also `view`, `section`, `query` and
  `similarTo` (`strippedURLKeys`): the keys of `imagesQueryParamSchema`, the images feeds' URL query,
  that `getInfiniteImagesSchema` lacks. The site merges that query into the filter-store input, so
  they arrive and zod strips them (the exception below). Also for `image.getInfinite` only, `useIndex`
  and `search` (`strippedLegacyKeys`): sent by clients the site no longer ships, keys the fallback log
  names under `input-unknown-key`; zod strips both and nothing else in the procedure's chain reads
  them, so they are ignored under the same exception. For REST, `token` (the API key, which then
  falls back as `bearer-token`). Every other input key the web client sends is a schema key. Every
  query key seen on `/api/v1/images` is a schema key except a small tail of hand-written requests,
  which now fall back. Before this, `/api/v1/images` kept an unknown key in `nextPage` and answered;
  `nextPageURL` still does so for every key of the query.
- **Exception: the stripped URL keys.** `view`, `section`, `query` and `similarTo` are
  `imagesQueryParamSchema` URL keys that `getInfiniteImagesSchema` lacks, so zod strips them, and
  `image.getInfinite` here ignores them as Node does rather than falling back. This deliberately
  departs from the rule above that an unknown key falls back even when the app's deploy runs ahead
  of this service's. The risk is the deploy gap: if one of the four becomes a
  `getInfiniteImagesSchema` key and the web app deploys before feed-go, the running feed-go still
  ignores it and answers as though it were absent. That is acceptable while `image.getInfinite` is
  shadow-only, and must be re-checked before `image.getInfinite` serves. The guard is one-directional:
  `TestStrippedURLKeysAreStrippedByZod` pins the list as literals and fails when
  `getInfiniteImagesSchema` gains any of the four, which happens on the web PR that adds the key
  (it regenerates `schemas.json`); the feed-go change that reads the key must ship first. A key
  added to `imagesQueryParamSchema` alone is not detected and falls back as `input-unknown-key`.
  `TestStrippedLegacyKeysAreStrippedByZod` is the same guard for `useIndex` and `search`. Any other
  key outside the schema still falls back: which keys arrive is read from the fallback log's safe
  detail (the first unknown key in sorted order), so a key that only ever travels beside one of these
  shows up once they are ignored.

### 5.2 devalue (`TRPC_WRITE_DEVALUE`, default off)

The Node pools write devalue where `TRPC_WRITE_DEVALUE=true`; this service reads the same variable, the
same way (exactly `true`), and writes devalue in exactly the cases the app does
(`src/server/trpc/response-write-format.ts`): a request from the web bundle (`x-client: web`) at a
version of at least `5.0.2080` (`canDecodeDevalueResponse`, node-semver's strict parse), for an
answer that is not edge-cacheable (a signed-out answer is cached by URL and served to any client, so
it stays superjson). Every other answer, every proxied one and every shadow or probe computation is
superjson, as before. There is no response header naming the format: the client tells them apart by
the type of `result.data` (a string is devalue). The devalue answer carries the private
`Cache-Control`, as the app's does.

The body is tRPC's envelope around `devalue.stringify(value)` as a JSON string:
`{"result":{"data":"[{\"items\":1,…},…]"}}`. `internal/devalue` writes it byte for byte as devalue
5.9 does: one entry per distinct value in first-reached order, equal primitives written once, the same
object, array or Date (the same Go reference: one `superjson.Object` / `[]any` backing array, one
`*time.Time`) written once and referenced after, `undefined` / `NaN` / `±Infinity` / `-0` as their
fixed negative indexes, devalue's string escapes (`<` as `\u003C`, U+2028 / U+2029), JS key order
(array-index keys first). The builders put one reference where the Node code puts one instance: an
image's `sortAt` Date is its `publishedAt` and its post's `sortAt` / `publishedAt`, the post `user` is
its first image's, a creator's `cosmetics` and `profilePicture` and their `deletedAt` Date are shared
by all their images. That is what makes the bodies smaller than superjson's (shared objects written
once) and lets a client compare Go's and Node's bytes.

The goldens hold Node's own devalue body for every served fixture (`testdata/golden/devalue/`, written
by the generators from the same value as the superjson envelope); the harness requires feed-go's bytes
to equal them, every byte, the cached records' key order included (§5).


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
- **Concurrency cap (bulkhead).** At most `FEED_GO_MAX_IN_FLIGHT` public requests compute at once
  per pod. It mirrors the Node app's `heavy-image` bulkhead (`acquireBulkheadSlot`,
  `src/server/utils/request-bulkhead.ts`): one per-pod counter shared by `image.getInfinite` and
  `image.getImagesAsPostsInfinite` (`heavyProcedure`), `GET /api/v1/images`, `/api/v1/blocks/images`
  and `/api/v1/posts/[id]`, capped at `HEAVY_REQUEST_CONCURRENCY` (default 20); a non-blocking
  acquire, no queue, the excess fast-failed (429 on tRPC, 503 with `Retry-After: 2` on REST) and
  counted. The acquire here is the same: non-blocking, no queue. Two things differ:
  - **The default.** Node's 20 is sized for one JS thread, where in-flight requests interleave on a
    single core; that does not carry over to Go. What bounds a Go compute is the replica pool, so
    unset (or zero, negative, junk) the cap is the pool's connection ceiling (`FEED_GO_DB_MAX_CONNS`,
    a `pool_max_conns` in the URL, or `dbpool.DefaultMaxConns` = 8; `server.ResolveMaxInFlight`).
    Every admitted compute can then hold a connection, so a full pod sheds at once rather than
    admitting computes that wait in the pool until the budget makes them `deadline` fallbacks. The
    pool is shared with shadow samples and probes, so under shadow load the cap is an upper bound,
    not a guarantee of a free connection. An explicit value wins; one above the ceiling is logged as
    a warning at startup (not refused). The startup log carries both values. There is no unlimited
    setting.
  - **The answer past it.** Rather than refuse, this service does not compute and proxies the request
    to the Node app — fallback reason `bulkhead` in `feed_go_fallback_total` — so routing to Go is
    never worse than not routing (the Node pod then applies its own bulkhead).

  The slot covers the computation only, not a fallback proxied after it, and is released by a defer
  when the computation returns, however it ends (answer, fallback, error, panic). A deadline or a
  client leaving releases it only as soon as the computation honours its context: one stuck in a call
  that ignores the context keeps its slot until it returns, visible as `feed_go_serve_in_flight`
  staying high. `feed_go_serve_in_flight` is the slots held now. Only the public route takes a slot;
  the origin hand-off computes nothing and takes none, and shadow samples and probes keep their own
  bounds (`FEED_GO_SHADOW_WORKERS`, the probe queue). **Any endpoint served here in future must take
  its slot from this same counter**, as Node's routes share one key, so a pod's cap covers all of
  them together.
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

### 6.2 The API request policy

The tRPC route runs `applyApiRequestPolicy` (`src/server/middleware/api-request-policy.ts`) before
anything else: a 451 for a blocked region, the default response headers, and the verified-crawler
request header. The public route applies it as follows, before the origin check (as on the app):

- **Region block.** A request from a region on `REGION_BLOCK_CONFIG` falls back as `region-blocked`, and
  the app answers its own 451 (body and headers). The region is `getRegion`'s: `cf-ipcountry`, with
  `cf-region-code` appended for the US (`US:CA`), and `x-isuk` `true`/`1` read as GB. A rule applies from
  the end of its date, UTC. The list is the variable when it is set, else the app's
  `DEFAULT_REGION_BLOCK_CONFIG`, which `internal/apipolicy/apipolicy.json` carries. That file is
  generated by `scripts/feed-go-api-policy.ts` and pinned by `scripts/__tests__/feed-go-api-policy.schema-drift.test.ts`,
  so the list is never copied by hand. The 451 is handed back rather than written here so that the
  status, body and headers stay the app's own; blocked traffic is cheap for the app to answer.
- **Verified crawler.** `verifyBot` grants the header only when the user agent matches a crawler
  pattern and the IP is in that crawler's published ranges. A request whose user agent matches one of
  the patterns (generated into the same file) falls back as `crawler-user-agent`, because only the app
  holds the ranges and the header changes the answer. One that matches none can never be verified, so a
  header it carries is one the app would strip: `image.getInfinite` reads it as absent (§14.2), the
  other procedures still fall back (`verified-bot`).
- **Default response headers.** Every answer written here carries its Cache-Control: the app's
  `PRIVATE_CACHE_CONTROL` (from the same file) unless the answer is edge-cacheable (signed out, §4).
  `X-Handled-By` (the Node pod name) is not set. It does not affect caching and names a Node pod.

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
  "node": { "json": …, "meta": … },
  "responseHeaders": { "cache-control": "…", "vary": "…", "cache-tag": "…", "set-cookie": "present",
                       "x-update-required": "…" } }
```

`responseHeaders` holds only the compared headers Node's
response carried (`FEED_GO_COMPARED_RESPONSE_HEADERS`): lowercased, each value cut at 1024
characters, and Set-Cookie as the literal `present`, never its value. So the sample grows by a few
hundred bytes at most.

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
  `infinite` for §14, `model-getall` for §15, `v1-models` / `v1-models-id` for §16, `model-associated`
  for §17): seven values, so the label at most multiplies a family's cardinality by seven;
- differing paths (never values) are logged for a sample, so a category can be traced to a field;
- numbers compare numerically, except that two integer literals compare **exactly** (int64, else as
  big integers). As float64, an integer above 2^53 cannot be told from its neighbour, and the
  relative tolerance would also equate large integers that differ by one;
- **response headers** compare as their own result,
  `feed_go_shadow_response_total{result="match|mismatch|uncompared"}`. They are kept apart from the
  body's `feed_go_shadow_compare_total`, so the match-rate queries keep their meaning; the go/no-go
  needs both. Each difference is counted in `feed_go_shadow_field_diffs_total` under category
  `header:<name>`, with kind `value`, `missing-in-go` or `missing-in-node`. The Go side is what the
  public route writes: its Cache-Control is `trpc.ResultCacheControl`, the one function
  `trpc.WriteResult` also calls, and its Vary is `trpc.Vary` (`trpc-accept, accept`, the value tRPC's
  `resolveResponse` sets on every answer). Noise rules (`shadow.CompareResponse`):
  - Cache-Control and Vary compare as sets of lowercased directives or names (`max-age=060` reads as
    `max-age=60`); Cache-Tag as a set of tags; Set-Cookie by presence.
  - An empty value is absent.
  - A sample without the fields (a sampler that predates them) is `uncompared`.
  - X-Handled-By (the pod), Content-Type/Length and Date (transport), and the rate-limit,
    Retry-After and site-alerts headers (per caller or per moment) are never compared.
  - On `v1-images` the response is `uncompared`: that port writes no headers of its own yet, so a
    comparison would only count Node's as missing here. The model routes (`v1-models`,
    `v1-models-id`) compare the headers their public route writes, over a longer list when the
    sampler sends it (§16.8).
  - **The status is not compared.** Node posts only the samples it answered 200, and an answer
    computed here is a 200 by construction (a constant, not a status this service decided), so a
    status compare could never fire. Comparing a status needs a sampler that posts its non-200
    answers and a Go side that can answer one.

  Expected differences until ported: `header:x-update-required/missing-in-go` (Node tells an
  outdated web bundle to reload; this service does not). They are still counted (as `mismatch`), but
  a sample whose only differences are these is logged at Debug; a body difference or any other header difference is logged at Info.
  `image.getInfinite` is not on the list: a signed-out unbatched call is cacheable in Node
  (createContext), and its compute carries the same signed-out TTL as the gallery procedure's.

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
   - it counts a stale tag-ids entry as a miss Go computes, as a serve with write-back off does; a
     serve with write-back on whose revalidation lock is held elsewhere serves it instead, so there
     the probe overstates the reads;
   - it does not evaluate the tag-ids browsing gate (deliberately): whether a miss needs the gate is
     known only from the tag rows a serve queries, which the probe never does. A serve fails such a
     miss (`tag-ids-miss-failed`) only when the image has a Rekognition label beside a WD14 tag AND
     the blocked-tag list cannot be read (its key absent, or a value Node would rebuild); the probe
     reports that case `would_serve`. On `image.getInfinite` the list is read before hydration, so an
     unreadable one is already `would_miss` there (`blocked-tags`); on the other procedures the
     overstatement is bounded by how often that key is absent, which
     `feed_go_cache_miss_total{cache="tag-ids",result="error"}` counts on the serving side;

   The caveats on misses Go computes (the cosmetic lower bound, the stale tag-ids entry, the tag-ids
   gate) apply equally to a raced entry on such a cache: since it is costed and classified as a miss
   there (below), whatever over- or understates that miss's reads or verdict does the same for it;
3. records the result in `feed_go_gofirst_total{feed_endpoint,result}`:
   - `would_serve`: every cache answered, or missed only where Go answers the miss itself
     (`Sources.MissReason` is `""`): from the replica (basic users, profile pictures, thumbnails,
     cosmetic records) or, with the miss computation on (`FEED_GO_COMPUTE_MISSES`, default on), by
     computing it (user cosmetics, image frames, tag ids, event decorations, and on model.getAll the
     model frames and decorations: `hydrate.MissCaches`);
   - `would_miss`: a cache Go falls back on missed — with the computation on, metric hashes when no
     ClickHouse reader is configured (the five per-image caches above too with it off) — or before hydration the session user
     (`session-cache-miss` / `-cleared`), the gallery settings (`gallery-settings-miss` /
     `-stale`) or, for `image.getInfinite`, the blocked-tag list (`blocked-tags-miss` / `-stale`);
   - `raced`: as `would_serve`, but a present entry of a cache Go falls back on
     (`Sources.MissReason` non-empty) was filled at or after the request began (its `cachedAt`, or
     a metric hash's `_populatedAt`, is at least `startedAt` − `RaceSkewMargin`, 100 ms): most
     likely by the Node request this probe races, so a Go-first serve would have found it missing
     and fallen back. A raced entry on a cache Go answers itself does not make the probe `raced`:
     a Go-first serve would have answered it as it answers a miss there, so it stays `would_serve`
     and its lookup is costed instead (the cost gate, below).
     `feed_go_gofirst_raced_total{feed_endpoint,cache}` counts the probes with a raced entry per
     cache, every cache, whatever the result. Not served: it is not in the numerator of the served
     share. `would_miss` wins over it (a miss was seen anyway);
   - `unsupported`: Go falls back for any other reason (an input shape, a bearer token, a sponsored
     post it cannot decide, the request budget); the reason is on
     `feed_go_fallback_total{mode="probe"}`;
   - `error`: a store read failed (a miss it cannot tell from one), a panic
     (`feed_go_panics_total{where="probe"}`), or a malformed probe;

   and, once per probe for each cache that missed at least one id (whatever the result),
   `feed_go_gofirst_miss_total{feed_endpoint,cache}`, so the caches that block serving read in
   order of how often. A miss Go computes is listed there too: `feed_go_gofirst_miss_total` is the
cold-cache rate, `would_miss` only the share that blocks serving.

**One enumeration.** `hydrate.PageCaches` is the single list of the per-entity caches a page reads,
with the fallback reason a miss raises without a miss computation; `Sources.MissReason` clears it
for the caches the computation answers, by the computation's own list (`hydrate.MissCaches`). The
tests pin both against `Page` itself: `Presence` reads exactly the keys `Page` reads, with each
cache emptied `Page` falls back with that row's reason or answers the page, and with frame-cache-
negative off a frame `notFound` marker is a miss for both. The golden tests (which serve with the
computation on, as production does) run the probe beside serving on every fixture, and with each
cache of every served fixture emptied, and require the same verdict; the `cold-*` fixtures are
`would_serve` with their cache reported, and every cache Go computes is required to reach that
`would_serve` arm at least once with its cache emptied. A miss Go answers itself is still reported per
cache, and costed (below). The probe never computes a miss.

**The cost gate.** A miss Go answers itself (replica path or computed) is served, but each costs a
database query a warm cache does not; so does a raced entry on such a cache, which a Go-first serve
would have found missing. Per served probe (`would_serve`, `raced`), the probe counts one query per
page and cache with such a miss or raced entry (once when that page's cache has both),
`feed_go_gofirst_db_reads_total{feed_endpoint,cache}`
(a lower bound: the user-cosmetics and frame computations, image and model, can each add the
withheld-cosmetic check's two queries, and a computed tag-ids miss counts one read, its tag-records
query for the tags `basic-tags` misses not included), over the pages it checked,
`feed_go_gofirst_pages_total{feed_endpoint}`. **These miss frequencies are
measured while Node re-warms the cache**: every probed request is also answered by Node, which
writes back what it reads. A Go-first serve with write-back OFF (`FEED_GO_CACHE_WRITEBACK`, default
off) writes nothing, so its misses recur on every Go-served request for those ids and the measured
rate understates the steady state. **Write-back must be ON before ramping past 10%** (the rollout
order, §3.1).

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
`VersionImages`, the creator memberships) is not the page hydrator `PresenceProbe` stands in for, so
its probe runs the serving path itself (`prepareModelGetAll` + `modelfeed.Serve`) under
`hydrate.WithPresence`. A miss Go computes there (the model frames and decorations, the version
showcases, the showcase images' tag ids, the model data and tags, the official models) is recorded
with its one lookup query and answered as "no entry", never looked up or written, with exceptions
for the misses whose answer decides which rows a page keeps: a showcase miss (a model without
showcase images is dropped), a model-data miss (a model with no data is dropped), a model-tags miss
(the tags decide the excluded-tag drop) and the official models (they decide the pinned page) are
looked up, read-only and on the replica, as "no entry" would make the probe page on (more page
queries, and misses a serve would never meet). Every other cache miss falls back, and the probe
reports the cache its fallback names (`creator-memberships`, `user-cosmetics`, and `model-data`,
`model-tags`, `version-images`, `model-frames`, `model-decorations`, `tag-ids` and `official-models`
with the computation off, and the pre-hydration ones) as `would_miss`.
So it sees only the FIRST cold cache Go falls back on, queries the replica as serving does (the page
query, basic users and profile pictures on a miss), and records no `raced` entries: its served share
is an upper bound by the race. Each `ModelPage` call counts as a page; its cost figure counts the
computed misses' reads only (not the replica reads of basic users, profile pictures, cosmetics, tags
or privacy defaults on a miss), so it is a lower bound, and `feed_go_gofirst_check_lag_seconds` is
observed from the first `ModelPage` call.

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
whether the race was lost: that is `feed_go_gofirst_raced_total` per cache, every cache whatever the
result (the `raced` result counts only the probes that lost it on a cache Go falls back on; with
every page cache answered by Go, as with the miss computation on and a ClickHouse reader configured,
it reads 0 while races still happen). Where the probe loses the race it reads an
entry Node just filled; the entry's own fill stamp says so. On a cache Go falls back on the probe is
then `raced`, not `would_serve`; on a cache Go answers itself it stays `would_serve`, with that
entry's lookup counted in the cost gate (it is what a cold miss there costs). What the stamp cannot
catch: an entry with no stamp (a frame record, a profile
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

# The share of probes that lost the race on a cache Go falls back on (`raced`; 0 when Go answers
# every page cache itself, e.g. miss computation on with a ClickHouse reader).
sum(rate(feed_go_gofirst_total{feed_endpoint="as-posts",result="raced"}[1h]))
  / sum(rate(feed_go_gofirst_total{feed_endpoint="as-posts"}[1h]))
# How often the probe lost the race at all, per cache (every cache, whatever the result: a race on a
# cache Go answers itself is costed in (3), not counted as `raced`).
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

**Gate windows must start after the race reclassification rolls out.** Since a race on a cache Go
answers itself stopped making a probe `raced` (it is `would_serve`, its lookup costed as a database
read), the served share (2) and the DB reads per page (3) both step up at that deploy. The step is the
reclassification, not Go serving better or reading more: a window that spans the deploy mixes the two
definitions, so read both figures over a window that begins after it.

## 8. Flags the Node path reads, and what this service does with them

This service evaluates one Flipt flag, `image-metrics-dedicated-clickhouse`, itself (`internal/flipt`,
§3.1; a general Go Flipt client is a follow-up). Every other flag below is either irrelevant to the
DB path, mirrored by an env var, or makes the affected requests fall back while on.
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
| `use-model-version-cache-for-images` | `image.getInfinite` only: a `prioritizedUserIds` request on the Postgres path takes its ids from `imagesForModelVersionsCache` and is re-sorted into that cache's order; off in production (enabled: false, no rollout) | `FEED_GO_PRIORITIZED_VERSION_CACHE` (default off): on, those requests fall back (`prioritized-version-cache`); off, the SQL branch is ported (§14.2) |
| `frame-cache-negative` | whether the image frame cache's notFound markers are live (read as "no frame", written for an hour on a miss) | `FEED_GO_FRAME_CACHE_NEGATIVE` (default off, as Node reads a flag it cannot evaluate): off, a marker is a miss (looked up, §3.1) and none is written, as in Node |
| `image-metrics-dedicated-clickhouse` | the image MetricService reads a dedicated ClickHouse for entity metrics instead of the shared one | read from Flipt (not mirrored): every 5 s in the background; on with `CLICKHOUSE_METRICS_*` set, the metric-hash populate reads the dedicated reader (§3.1) |
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
- a failed miss computation (§3.1, `<reason>-failed`; for tag ids also a browsing gate this service
  cannot read when a row needs it), cache misses on metric hashes without a ClickHouse reader
  (`metrics-miss`), session users (auth hub fetch not ported), gallery settings (rebuild not ported);
- API keys other than those §4.2 serves, verified crawlers (but on `image.getInfinite`, §14.2), POST
  (`methodOverride`) requests;
- public requests from an origin the app's allow-list does not hold (reason `origin`, see §4).

**Matched behaviour worth knowing:** a page query that runs past the 20s statement timeout answers an
empty page, as Node does, rather than falling back (which would run the same slow query a second time
on Node). A metric hash holding only the `notFound` marker is a KNOWN image with zero counts
(`statsUnknown: false`): `getImageMetricsObject` gives every id whose hash exists an entry on both
its arms, so `toImageV2Stats` only reports `statsUnknown: true` when the ClickHouse read failed and
no hash was cached — a case this service falls back on (`metrics-miss` without a reader,
`metrics-miss-failed` when its own read fails) instead of answering.

**Divergences of the miss computations (§3.1):**
- with write-back off, the frame and event-decoration lookups read the replica; Node's read the
  primary. Within replica lag of an equip or unequip, Go can answer the previous state for that one
  request (nothing is cached). With write-back on they read the primary, as Node's do;
- with write-back off, a computed answer is reused in process for 10 s (§3.1, repeated misses): an
  equip, unequip or withhold within that window shows on this pod up to 10 s late, where Node, which
  reads its own fresh write or the lookup again, shows it at once. Concurrent requests for the same
  cold ids share one lookup, run under the first request's context (its cancellation fails the
  others' computation, which then falls back);
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
  populates of metric hashes while no reader is configured, and model.getAll's cache misses — misses Node pays and Go falls back
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

### 10.3 Traces, exemplars and fallback logs

Tracing, exemplars and the fallback lines are off until the deployment sets the variables below.
**What does change on merge** is the compute-error and proxy-error log lines (`feed compute failed;
falling back`, `shadow compute failed`, `go-first probe failed`, `fallback proxy: the Node app did not
answer`): they log the error's class and Go type instead of its text, at most
`FEED_GO_ERROR_LOG_PER_MIN` (default 60) per key per minute, and a new counter,
`feed_go_errors_total{feed_endpoint, mode, class}`, counts every one of them.

**Tracing** (`internal/tracing`) mirrors the Node app's setup (`src/instrumentation.node.ts`), so one
configuration drives both and a trace continues browser → feed-go → Node on the public routes:

| Variable | Meaning |
|---|---|
| `FEED_GO_OTEL_ENABLED` | `true` turns tracing on (with an endpoint). feed-go's own switch, not the app's `OTEL_ENABLED`: feed-go's environment includes the shared app config, and a switch read from there would turn tracing on with no change to feed-go's deployment. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The collector's base URL, as Node's: spans go to `<it>/v1/traces`, OTLP over HTTP/protobuf (Node's `exporter-trace-otlp-proto`). The standard `OTEL_EXPORTER_OTLP_*` headers/timeout variables apply. |
| `OTEL_SERVICE_NAME` | `service.name` (default `feed-go`). Set it EXPLICITLY on the feed-go deployment (`feed-go`) when turning tracing on: the shared app config in feed-go's environment could carry Node's, and would then label feed-go's spans as Node's. Node's `SERVICE_NAME` fallback is not read, for the same reason. |
| `OTEL_TRACES_SAMPLE_RATIO` | Head-sampling ratio, Node's rule: a number in [0, 1], else 0.1. |

- *Sampling* is Node's `buildHeadSampling`: ParentBased over a trace-id ratio, the ratio applied to
  remote SAMPLED parents too (a `-01` traceparent alone does not force sampling), a remote unsampled
  parent dropped, a local parent inherited. The ratio caps sampling for honest callers only: the
  decision is a function of the trace id, so a caller who picks a trace id whose words XOR low is
  sampled every time — the same as Node's `buildHeadSampling` (parity, not a defence). The ratio sampler is a port of the JS
  `TraceIdRatioBasedSampler` (`tracing.NodeRatio`: the trace id's four 32-bit words XORed, kept below
  `floor(ratio × 0xffffffff)`), NOT the Go SDK's `TraceIDRatioBased`, which reads the low 8 bytes and
  so keeps a different subset for the same ratio: with it, a trace Node kept would continue in
  feed-go only at random (its test pins decisions taken from the JS sampler itself).
- *Spans.* One server span per request, named `<mode> <feed_endpoint>` (`serve as-posts`,
  `shadow model-getall`, `probe infinite`), a child of the caller's `traceparent` when there is one
  (W3C trace context + baggage, Node's default propagators). On the public `:8080` routes that is the
  browser's (the Faro frontend sends it same-origin) or an edge's: the go-arm path, where feed-go
  serves and the Node app sees only the fallbacks. Attributes: `feed_endpoint`, `feed_go.mode`,
  `feed_go.outcome` (the `outcome` / shadow result labels), `feed_go.fallback.reason`,
  `feed_go.shadow.result`; a fallback adds a `fallback` event (reason, safe detail), an error an
  `error` event (class, type) and the error status. Children: one per pgx query (`pgx SELECT`:
  operation and a hash of the SQL text, never a bind value or the text), one per Redis command or
  pipeline (`redis get`, `redis pipeline`: the command name and count, never a key or argument), one
  per ClickHouse read of the metric-hash misses (`clickhouse query`, `internal/chread` through
  `tracing.ClickHouseTracer`: the operation keyword and the rows returned, never the SQL, not even a
  hash of it since the read inlines its ids, nor the request URL, which carries the query; a refused
  slot, a timeout or a ClickHouse exception is the error status, its class, and `error.type`), the
  waits on work the request did not start (`internal/hydrate`, `MissCompute.Tracer`): `miss lookup
  join`, on a request that joins another request's in-flight miss lookup (the lookup's own spans sit
  under the request that runs it), from reaching the flight to its answer, with `feed_go.miss.cache`
  and `feed_go.miss.shared=true` (an answer kept in the few-second in-process memo is a map read and
  gets none), and `metrics lock wait`, the metrics lookup's whole wait on a populate lock another
  process holds (a Redis read every 100 ms up to `FEED_GO_METRICS_LOCK_WAIT_MS`, five by default), with `feed_go.metrics.wait.ids` (a count),
  `.polls` and `.outcome` (`filled`, `exhausted`, `ctx_done`, `read_error`; all but `filled` are the
  error status), never an id, a key or SQL; and
  the fallback proxy hop (`fallback-proxy <endpoint>`), whose context the proxy injects as the
  outbound `traceparent` so the Node request is its child. With tracing off the proxy passes the
  inbound `traceparent` through unchanged, as before.
- *The proxy hop carries feed-go's sampling decision to Node.* With tracing on, every proxied request
  carries feed-go's `traceparent` (sampled flag included), and Node's ParentBased sampler follows a
  remote parent: an unsampled one is dropped, a sampled one is re-checked against Node's own ratio.
  Node's traces of proxied requests are therefore capped at min(feed-go ratio, Node ratio). Set
  feed-go's `OTEL_TRACES_SAMPLE_RATIO` at or above Node's (normally equal; both default 0.1), or Node
  loses traces of the requests feed-go hands back. Those requests now arrive WITH a `traceparent`, so
  Node's root pre-sampling (`otel-root-presample`), which applies only to requests without one, does
  not apply to them. No span per row or per hydrated entity; the
  store spans start only under a recording (sampled) request span.
- *Shadow and probe spans* are independent roots: the Node samplers do not send a `traceparent` on
  their POSTs, so a sample is not linked to the Node request it describes (an inbound one would be
  honoured, as on the public routes). They end when the comparison (probe) does, after the 202.

**Exemplars.** `feed_go_request_duration_seconds` and `feed_go_shadow_phase_seconds` carry the trace
id (`trace_id`) as an exemplar on observations made under a SAMPLED span only. With tracing on,
`/metrics` answers a scrape that asks for OpenMetrics in that format (the only one with exemplars);
Prometheus stores them with exemplar storage enabled. An exemplar's trace id can dangle: the head
sampler keeps the trace, but the collector may still drop it before Tempo (tail sampling in Alloy),
so a linked trace is found only once the collector retains feed-go's sampled traces (an infra
follow-up, not in this PR).

**Logs** (`server.EventLog`, the JSON slog handler on stdout). One line per fallback (`msg`
`fallback`: `mode`, `endpoint`, `reason`, `detail` when safe, `trace_id`/`span_id` when the request has
a span), per compute error (`feed compute failed; falling back`, `shadow compute failed`,
`go-first probe failed`: `err_class`, `err_type`) and per fallback-proxy error (`fallback proxy: the
Node app did not answer`, Warn for `upstream`, Debug for `canceled`). Each is rate-limited per (kind,
mode, endpoint, reason) by a token bucket; a line carries `suppressed` (lines that key dropped since
its last). No line is needed to see the rest: `feed_go_fallback_total` counts every fallback and
`feed_go_errors_total{feed_endpoint, mode, class}` (mode `serve` | `shadow` | `probe` | `proxy`) every
error, rate-limited or not.

| Variable | Meaning |
|---|---|
| `FEED_GO_FALLBACK_LOG_PER_MIN` | Fallback lines per key per minute (default 0: none). |
| `FEED_GO_ERROR_LOG_PER_MIN` | Error lines per key per minute (default 60). |
| `FEED_GO_CACHE_WRITE_LOG_PER_MIN` | `cache write` lines per (cache, result) per minute (default 0: none; §3.1). These carry the key and id written, never the value. |

*What is logged.* Never an error's text, the request input, a cookie, a token or an id. A fallback's
`Detail` (its `Error()` text) is never logged; its loggable detail (`fallback.SafeDetail`) is opt-in
at the call site: `fallback.Safef` (counts, status codes, the budget, a type name), `fallback.NewfSafe`
(a fixed field name, or an input key name / enum value through `fallback.Token`, a charset and
length filter — anything outside `[A-Za-z0-9_.-]` becomes `?`, cut to 64 bytes — that does NOT scrub
free text: `a.b@x.com` logs as `a.b?x.com`, so it is used for key names and enum values only), and `fallback.Wrap` (the error's class). `fallback.Newf` details — cursors, ids, user
values, sponsored data — log nothing but the reason.

*Error class* (`fallback.Class`, closed set `fallback.ErrorClasses`, also the counter's `class`
label): unwrapped to the most specific sentinel or kind, never text or values — `deadline`,
`canceled`; `pg_no_rows`, `pg_connect`, `pg_<SQLSTATE class>` (the two-character class only, e.g.
`pg_22` data exception, `pg_40` rollback, `pg_53` insufficient resources, `pg_57` operator
intervention; one of Postgres' classes), `pg_other`; `redis_nil`, `redis_pool_timeout`,
`redis_closed`, `redis_reply`; `timeout`, `conn_refused`, `conn_reset`, `dns`, `net_dial`, `net_read`,
`net_write`, `net_other`; `clickhouse_busy`, `http_4xx`, `http_5xx`, `http_other` (an upstream status);
`eof`, `json`, `other`. The `shadow diff` line is unchanged (paths
only), plus the trace ids.

*Overhead* (an estimate from what runs, not a measurement; the benchmarks do not cover the request
path). Off: a nil check per request. On, unsampled (1 − ratio of requests): the traceparent parse, a
non-recording span, one extra request copy (`WithContext`) and, on a fallback, the proxy hop's span —
a handful of small allocations, single-digit µs; the store hooks then cost one context lookup per
query or command. On, sampled: one recording span per request plus one per pgx query and per Redis
command or pipeline (a pipeline is one span), each built in a few µs and exported in batches off the
request path. Read the real figure from the phase CPU series (§10.1) before and after turning it on.

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
  `SERVER_DOMAIN_*` hosts, `REGION_RESTRICTION_CONFIG`, `REGION_BLOCK_CONFIG` whenever the Node pools set
  it (§6.2; unset, both use the same generated default), `IMAGE_QUERY_CACHING`, the flag mirrors, and
  `FEED_SERVICE_URL` (the same value as the Node pools) with `FEED_GO_IMAGE_INDEX_FEED` /
  `FEED_GO_LAZY_POST_IMAGES` at the flags' values, and `FEED_GO_FALLBACK_URL` (the in-cluster Node
  service) once serving. `FEED_GO_FRAME_CACHE_NEGATIVE` mirrors a live flag: the deployment must set
  it to `frame-cache-negative`'s production value (and change it when the flag changes), or frame
  markers are read and written differently from Node (§8). `FEED_GO_CACHE_WRITEBACK` stays empty (no
  cache written) until the operator decides, then lists caches one at a time; listing a cache whose
  lookup reads the primary also needs `DATABASE_URL` (§3.1). The metric-hash
  misses need `FEED_GO_CLICKHOUSE_HOST`, `FEED_GO_CLICKHOUSE_USERNAME`, `FEED_GO_CLICKHOUSE_PASSWORD`
  (§3.1): a dedicated SELECT-only login on what the populate reads, in feed-go's own Secret. The
  app's `CLICKHOUSE_*` keys reach feed-go through the shared app config but are ignored, so until
  that Secret exists the misses fall back (`metrics-miss`).
- **API keys are a separate operator decision.** Turning `FEED_GO_BEARER_AUTH` on (§4.2) requires giving
  feed-go `NEXTAUTH_SECRET`, the salt of the API-key hash. Node also uses that same secret for other
  signed tokens, so with it feed-go holds a credential well beyond what key lookups need. Enabling the
  switch therefore needs its own decision, not just a default deployment step. It also needs
  `ORCHESTRATOR_SERVICE_TOKEN` at the app's value. Until both are provided, leave the switch off: every
  API credential then falls back.
- **Network:** Node pods → feed-go `:9090` (shadow); feed-go → replica, both Redis (and the system
  Redis Sentinels), the JWKS endpoint, the image feed service, the primary (only with a primary-reading cache written back),
  ClickHouse's HTTP endpoint (only with a reader configured), and (serving) the Node service.
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
   2026-11-15, the tag-ids, model-frame and model-decoration ones after, and the metric-hash
   ClickHouse populate, §3.1). The populate stays off in a deployment until feed-go has its own
   SELECT-only ClickHouse login in its own Secret (`FEED_GO_CLICKHOUSE_*`); the app's read-write
   `CLICKHOUSE_*` keys it already receives through the shared app config are ignored by design.
4. **Flags** — a Flipt evaluation client so the env mirrors go away (a few days).
5. **Serving** — the client transport flag PR, a small cohort, then ramp while watching error rate,
   latency and the Node-side CPU drop. A week of ramp. The per-pod concurrency cap is in place
   (§6.1, `FEED_GO_MAX_IN_FLIGHT`, by default the replica pool's ceiling); during the ramp, read its
   `bulkhead` fallback rate against `feed_go_serve_in_flight`, and raise `FEED_GO_DB_MAX_CONNS` (the
   cap follows it) rather than the cap alone.

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
   (`getAllImages`, §13.2.1); everything else asks the image feed service (`route: 'rest'`): the browsing
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
   `modelVersionIds` (the detected resources), and `meta`: null without `withMeta`; with it, the
   image's entry of `imageMetaCache` (`{id, meta}`, its `meta` null when the image hides it), flat
   when `flatMeta` says so and, when it is absent, flat on the feed path and wrapped as `{ id, meta }`
   on the legacy path. Then `withoutHeldImages`: an image above its post's held model level is left
   out, whatever the request named.
8. **Body.** `res.json({ items, metadata })`, plain JSON (not superjson): `metadata` holds `nextCursor`
   (the feed's `feed:<a>:<b>`), `currentPage` / `pageSize` when paging, and `nextPage`, the request's
   own URL with `cursor` (or `page`) set, on `https://<host>` in production.

### 13.2 What is ported, and what falls back

| Area | Ported | Falls back (reason) |
|---|---|---|
| Query | every member above except those on the right, `ids` (the legacy path, §13.2.1), `withMeta` / `flatMeta`, Next's `req.query` parsing (repeated keys, `Object.keys` order for `nextPage`) | `imageId` (`v1-image-id`) and a `modelId` without a version (`v1-model-only`): the legacy Postgres path; `tags` (`v1-tags`), `baseModels` (`v1-base-models`), `withTags=true` (`v1-with-tags`); any value `Number()` would read differently from a plain integer (`v1-input-number`), an `ids` part that is not a plain decimal from 1 to 2^31-1, or more than 100 parts (`v1-input-ids`: hex, exponents and a `.0` read as integers there), a repeated schema key (`v1-input-duplicate`), a sort the feed does not have (`v1-sort`), `userId=0` (`v1-user-zero`), a malformed escape (`v1-query-encoding`), a key outside the schema other than `token` (`input-unknown-key`, §5.1) |
| Viewer | signed out; session cookies (the same resolver as §4); a banned session as signed out | API keys / bearer tokens (`bearer-token`); the sampler does not send them at all (§13.4) |
| Gates | withheld, held level, unknown version / post; the per-post hold on every page | a gallery settings key Node would rebuild (`gallery-settings-miss`); a held model whose settings carry no level (`v1-held-level-unset`) |
| Pages | the feed's page, its cursor, the empty-page answers (`requiringMeta`, `limit=0`, an empty feed answer); the legacy page (§13.2.1) | a feed failure or a non-200 (`feed-unavailable`, `feed-status`), a refusal Node answers with a 400 (`feed-refused`, `v1-cursor`, `v1-page-limit`), a hydrate that errors or empties the page (`feed-hydrate-error`, `feed-hydrate-empty`: Node retries an empty one on another replica); on the legacy path a cursor that is not a positive integer (`v1-legacy-cursor`) and a query error (`v1-legacy-error`) |
| Hydration | basic users (cache, replica on a miss), thumbnails, metric hashes, image resources (cache), the hold's post→version and version→model caches (replica on a miss or past their TTL), a `username` on the replica; with `withMeta`, `imageMetaCache` (brotli-compressed values and plain ones, notFound markers; a miss computed from the replica with its lookup's query, §3.1, never written back) | a metric hash miss without a ClickHouse reader (`metrics-miss`; with one it is computed, §3.1), an image-resources miss (`image-resources-miss`: Node picks a replica by write lag), a username the replica does not hold (`v1-username-miss`: Node reads the primary next); an image-meta miss without the miss computation (`image-meta-miss`) or one whose lookup failed (`image-meta-miss-failed`), a cached meta holding a value JSON.stringify writes as a Buffer (`image-meta-shape`) |
| Config | | no `FEED_SERVICE_URL` (`index-feed-unconfigured`), no `NEXT_PUBLIC_IMAGE_LOCATION` (`v1-image-location-unconfigured`) |

The endpoint publishes no cosmetics, frames, tags, reactions or event decorations, so this port does
not read them, and their cache misses (a fallback on the gallery procedure) cost nothing here.

### 13.2.1 The legacy path (`ids`)

An `ids` batch is `getAllImages` itself, not the feed: the same page query as image.getInfinite's
Postgres arm (`ImagesQuery.Build`), with the batch as `i."id" = ANY(…)` and the request's period
(`createdAt` since the period's start), type, post, version, creator (`userId`, or a `username`
resolved on the replica), the browsing addons (here the session user, username included, decides
the own-feed carve-out), POI and minor always excluded, no cache unless a version scopes it. Its
order is getAllImages', never the request's: the id descending (ascending for Oldest, the resource
join's id with a version), a post's own media by index when `postId` comes without `modelId`; a
repeated or unknown id is simply absent. Paging: `page` is `OFFSET (page - 1) * limit` (a 429 past
1000 as on the feed path), a cursor is the inclusive keyset on the order's column. `LIMIT limit + 1`;
the look-ahead row is popped and its cursor column is `nextCursor` — a NUMBER here (the id, or a
post's index, which can be 0 or NULL; then `nextCursor` is `0` / `null` and there is no `nextPage`),
so `limit=0` reads one row and answers an empty page with a `nextCursor`. A page of only unselectable
levels is empty without a query, and so is a statement timeout (as Node answers it on this path). The
publish filter, shaping and the per-post hold are the feed path's, except that `createdAt` is the
image's own (the feed path publishes `sortAt`), and an empty page is an answer (no read rescue).

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
class in `civitai_app_feed_go_v1_shape_total{class}`: `ported` (a shape the port answers, `ids` and
`withMeta` included), the `unported_*` shapes it falls back on by construction (`imageId`,
`modelId_only`, `tags`, `baseModels`, `withTags`), `unported_unknownKey` (a query key outside
`imagesEndpointSchema` other than `token`, read from the raw query since zod strips it; §5.1),
`api_key`, and `non200`. The share of the route a Go service
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
  pages, `stats.*` value diffs, as in §7;
- the legacy path reads this service's replica (Node: the DataPacket or the read replica by flag, the
  primary for a version scope while `image-resource-use-write` is on) and its own page cache;
- `imageMetaCache`: an entry past its 4h TTL is served as it is (Node re-reads the row when it takes
  the refresh lock, which only matters when the meta changed since); a miss is read from the replica
  and not written back, so it stays a miss for the next reader until Node fills it.

## 14. `image.getInfinite` (tRPC, shadow; served only behind `FEED_GO_SERVE_INFINITE`, default off)

The flat image feed (`/images`, a creator's images, a post's carousel tail, a tag page):
`src/server/routers/image.router.ts` (`heavyProcedure`, input `getInfiniteImagesSchema`) →
`getInfiniteImagesHandler` (`image.controller.ts`) → `getAllImagesIndex` (the feed service) or
`getAllImages` (Postgres), then `withSharedFeedUsers`. Ported in `internal/feed/infinite.go`; compared at
`POST /internal/shadow/image.getInfinite`. The public route exists but computes nothing unless
`FEED_GO_SERVE_INFINITE` is on (§14.8). It reuses the gallery port's feed
client, page query, page cache, hydration (one cluster pipeline per stage, `hydrate.Sources.Page`), the
REST port's post→version / version→model readers and username lookup, the session resolver and the
domain cap.

### 14.1 What the Node path does

1. **Middleware.** The same `applyDomainFeature` cap as §1 (every public procedure runs it). The
   procedure is in `NEVER_BATCH_PROCEDURES`, so the client sends it alone. Its cache policy is
   createContext's (nothing in the chain lowers it): a signed-out, unbatched call that is not a
   verified crawler is `public, max-age=60, s-maxage=60, stale-while-revalidate=30`, as for §1. The
   compute here records the same signed-out TTL, so the shadow header compare reads it as expected.
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
   hide-challenges tag; a `username` resolved to its id, unknown → 404), for `followed` with a
   signed-in viewer their follow list (`getUserFollows`; none: an empty page before the mapping), the
   feed query (`mapSearchInputToFeedQuery(input, 'primary', 'website')`, `tags` and `userIds` included,
   the follow list as `userIds`), then the rows by `feedHydrateQuery` (no paging, period or model scope;
   `tags`, the creator and `followed` kept, so the hydrate reads the follow list again and filters by
   it). Postgres
   path: one `getAllImages` call; a post's media are ordered `i."index", i."id"` and paged on the index,
   so `nextCursor` is the look-ahead row's index (a number, `0`, or `null`). A `collectionId` first
   reads the viewer's permission on the collection (`getUserCollectionPermissionsById`): no read is
   `{ nextCursor: undefined, items: [] }`; otherwise the page joins the collection's items (the `ct`
   CTE, below).
6. **Wire.** Each image as `getAllImagesUncaptured` builds it under `stripImageForInfiniteWire` only:
   the gallery's image plus `availability`, `meta` (`null` without `metaSelect`), `baseModel`
   (undefined without `includeBaseModel`) and `judgeScore` (`null` outside a collection; in one,
   `parseJudgeScore` of the item's note), and on a collection page the item's `collectionItemStatus`
   and `collectionItemAddedById` (its note is selected but not on the wire). Profile
   pictures only when `include` holds `profilePictures` (the handler adds `tagIds` alone); the votable
   `tags` (and the viewer's votes on them) only when it holds `tags`. The result is
   `{ items, nextCursor, source: 'feed' }` (feed), `{ nextCursor, items, source: 'db' }` (Postgres), and
   the bare `{ items, nextCursor }` of the gates and of an all-blocked tag scope on the feed path.
7. **`withSharedFeedUsers`** (`image-feed-shared-users` and `trpc-fast-superjson-shared-refs` both on):
   equal `user` objects become one shared object. superjson writes that as a referential equality, which
   the comparator ignores; no decoded value changes, so nothing is ported.

### 14.2 What is ported, and what falls back

| Area | Ported | Falls back (reason) |
|---|---|---|
| Input | the global feed; `modelVersionId` (with or without `modelId`), `model3dId`; a `modelId` alone (Postgres); the creator scope (`userId`, `username`); the post scope (`postId`, Postgres); the tag scope (`tags`); `baseModels` (below); `prioritizedUserIds`, `pending` and an `include` without `cosmetics` (below); `include` values Node never reads (`count`, `report`: answered as the list without them); `include` holding `tags` (below); `followed` (below); `collectionId` with `collectionTagId` and the Recently Added sort (below); `ids`, `reactions` and `newCreators` (below); the stripped keys of §5.1 (`view`, `section`, `query`, `similarTo`, `useIndex`, `search`); every sort, period, browsing level, filter and cursor §2 ports, with the same cursor refusals | Hat Turf keys (`infinite-hat-turf`); `hubId` and every other key in §2's right-hand column but `baseModels`, `followed`, `collectionId`, `collectionTagId`, `ids`, `reactions` and `newCreators` (`input-<key>`); `include` holding `metaSelect` or any other value not listed here (`input-include`, the entry in the safe detail; the gallery still falls back on `tags` too); `userId: 0` (`infinite-user-zero`: the feed and the hydrate read it differently) |
| `baseModels` | `z.string().array()`, read as sent (no list of names is consulted: the schema has no enum, and the match is on `ModelVersion."baseModel"` text). Feed path: the non-empty names, in order with repeats, as the feed query's `baseModels` after the POI exclusion (`.map(String).filter(Boolean)`, written as URLSearchParams writes it); the hydrate, and every Postgres read, binds the whole list into getAllImages' `EXISTS (… "ModelVersion" mv RIGHT JOIN "ImageResourceNew" ir … WHERE mv."baseModel" = ANY(…))`; the cache policy is unchanged (Node does not mark it personalized). `image-resource-use-write` would send these reads to the primary in Node; it is not mirrored (§8) | not a list, or an entry that is not a string (`input-invalid`: Node's BAD_REQUEST) |
| `prioritizedUserIds` (the model page's showcase carousel: `modelVersionId`, the owner's id, `pending`, `include: []`) | with a `modelId` or `modelVersionId`, the Postgres page of `getAllImages`' prioritizeUser branch with the version cache off: no `ImageResourceNew` join (`p."modelVersionId" = <version>` when there is one, no model scope at all for a model alone), `i."userId" = ANY(<ids>)`, ordered `(i."postId"::bigint * 100) + COALESCE(i."index", 0), i."id"`, the cursor column still the sort's (`nextCursor` is the look-ahead row's id), never cached; without a model, the feed path's empty page (the mapper refuses `input:prioritizedUserIds`); `[-1]` alone (the system user) with a version: Node's `hasSystemPosts` read on the replica (`SELECT id FROM "Post" WHERE "userId" = -1 AND "modelVersionId" = <version> LIMIT 1`); with a post, the branch above; without one, no creator clause and `IIF(i."userId" IN (-1), i.index, 1000),  ` ahead of the sort's own order | a truthy cursor (`prioritized-cursor`: Node's BAD_REQUEST); `[-1]` alone on a model without a version (`prioritized-system-user-no-version`: Node reads no post and sorts every visible image on the site by the `IIF`, with no model or creator clause; that unbounded sort is left to Node); `FEED_GO_PRIORITIZED_VERSION_CACHE` on (`prioritized-version-cache`) |
| `ids` | `z.array(z.number()).max(200)`, as sent; non-empty, always the Postgres path (`requiresImageDbPath`): `i."id" = ANY(<ids>::int[])` first in the WHERE clause, the sort's own order and cursor, the scope's cache policy. The answered images are then held by their own post's model (the handler's `withoutHeldFromViewer`, not for a moderator): `getHeldLevelsByPost` over the post→version and version→model caches and the gallery settings, and for a held model its owner (`SELECT id, "userId" FROM "Model"` on the replica); an image on a held model's post is kept only at a level intersecting the hold, or for the model's owner. An empty list is no filter and no routing (`?.length`) | not a list, a null, an entry that is not a number, or more than 200 (`input-invalid`); an entry that is not an int4 integer (`ids-not-int4`: Postgres refuses the bind); a held model without a level (`held-level-unset`); the gallery still falls back (`input-ids`) |
| `reactions` | `z.array(z.enum(ReviewReactions))`, as sent; non-empty, always the Postgres path. Signed in: `i.id = ANY(ARRAY(SELECT ir."imageId" FROM "ImageReaction" ir WHERE ir."userId" = <viewer> AND ir.reaction = ANY(<kinds>)))` after the prioritizeUser branch and before `tools`, never cached. Signed out: no clause (`userId && reactions?.length`), the unfiltered Postgres page | not a list, a null, or a value outside the enum (`input-invalid`); the gallery still falls back (`input-reactions`) |
| `newCreators` | `z.boolean()`, not coerced. The board of the request's board color (`getRequestBoardDomainColor`: a host on red's list, or an alias of a color whose primary is, reads `images-new-red`; every other `images-new`), read from `getNewCreatorUserIds`' fetchThroughCache entry (`packed:caches:new-creators:<board>`, fresh within its hour) once per request where Node reads it twice; the addons resolved under the `newCreators` scope. Feed path: an empty board is `serveFromFeed`'s empty page before the mapping; past 10,000 (`newCreators>10000`), or beside a creator scope or any `followed: true` (`flag:newCreators:userId`), the mapper's empty page, refused after the follow list's checks; otherwise the board's positive ids as `userIds`, and the hydrate binds the board. Postgres path: `i."userId" = ANY(<board>)` after the follow clause, `1 = 0` for an empty board. Not personalized | not a boolean, a null included (`input-invalid`); no entry (`new-creators-miss`: Node builds it from the database), an expired one or one whose `data` is not a list of integers (`new-creators-stale`), a failed read (`new-creators-read-failed`); the gallery still falls back (`input-newCreators`) |
| `pending` | no published-before-now clause; a moderator's view `(nsfwLevel & level) != 0 OR nsfwLevel = 0`, a signed-in viewer's `pendingViewerImageSql` (no `reviewCollectionId`: server-set), signed out the reviewed view; the pending view is never cached; on the feed path the mapper's empty page (`flag:pending`) | |
| `include` without `cosmetics` | no user-cosmetic, frame or cosmetic read (nor their miss lookups): `user.cosmetics` `[]`, `cosmetic` `null`; the probe checks the same keys | (the gallery still falls back: `input-include-no-cosmetics`) |
| `include` holding `tags` | the votable tags (`getImageTagsForImages`): `imageTagsCache` (`packed:caches:image-tags:<imageId>`) read in the page's first pipeline, each tag `{...rest, imageId, id: tagId, type: tagType, nsfwLevel: tagNsfwLevel, name: tagName}` in cached order; for a signed-in viewer their `TagsOnImageVote` rows on the page's images (replica, as Node's `dbRead`) merged as `vote` (`1` for a vote > 0, else `-1`) on the tags they voted; an image whose entry is a `notFound` marker or holds no tag has `tags: undefined`. A miss is computed (§3.1, `image-tags-miss`), never written back; the probe checks the same keys | a miss without the miss computation (`image-tags-miss`), a failed lookup (`image-tags-miss-failed`), an entry Node's `.tags.map` would throw on (`image-tags-shape`); the gallery still falls back (`input-include`) |
| `followed` | `z.boolean()`, not coerced. Signed out: dropped on both paths (no follow read). Signed in: the viewer's follow list (`getUserFollows`: `userFollowsCache`, `packed:caches:user-follows:<userId>`, `userFollows[userId]?.follows ?? []`, a `notFound` marker as none), read once per request where Node reads it twice (the feed call and the hydrate). Feed path: no follows is `serveFromFeed`'s empty page before the mapping (an unreadable cursor included); more than 10,000 (`followed>10000`) or beside a creator scope, `userId` or a resolved `username` (`flag:followed:userId`), the mapper's empty page, refused after the post ids and before the sort and cursor; otherwise the positive ids, in cached order, as `userIds`, and the hydrate binds the list as `i."userId" = ANY(…)` after the creator clause (Node inlines `IN (…)`). Postgres path: the same clause for a non-empty list, none for an empty one (the unfiltered page, as `prefetchedUserFollows?.length` reads it). Personalized: never cached. A miss is computed (§3.1, `user-follows-miss`), never written back | not a boolean (`input-invalid`); a miss without the miss computation (`user-follows-miss`), a failed lookup (`user-follows-miss-failed`), an entry Node would read differently: another user's record under the key, a `follows` that is not a list of integers (`user-follows-shape`); on the Postgres path a list longer than 10,000 (`followed-db-many`: Node binds one parameter per id); beside `newCreators`, `hubId` or a Hat Turf key, those keys' own fallbacks; the gallery still falls back (`input-followed`) |
| `collectionId` | `z.number()`, a positive int4; always the Postgres path (`requiresImageDbPath`). After this service's own refusals (the cursor, `prioritizedUserIds`), the permission read on the replica: the `Collection` row's `read` and owner, and for a signed-in viewer their `CollectionContributor` permissions (Node's accepted-invite join only feeds `isCollaborator`, so it is not read). Answered: a Public or Unlisted collection (to anyone, a moderator included), a collection the viewer owns, and no read at all (a collection that does not exist, a private one signed out, to a contributor without VIEW, or to anyone else): Node's `{ nextCursor: undefined, items: [] }`, stamped `source: 'db'`, with no page query. The page: the `ct` CTE over `CollectionItem` (`ci."collectionId"`, `ci."imageId" IS NOT NULL`, the status filter `ci."status" = 'ACCEPTED'`, for a signed-in viewer `OR (ci."status" <> 'REJECTED' AND ci."addedById" = <viewer>)`, the empty-seed `sortKey` hash Node computes outside Random), `JOIN ct ON ct."imageId" = i.id` after the Post join, `ct.note`, `ct.status` and `ct."addedById"` selected after the cursor column; outside the pending view the acceptableMinor clause is `= FALSE` signed out, `(= FALSE OR i."userId" = <viewer>)` signed in, none for a moderator. Not personalized: the cache policy is the scope's (a version, model or Model3D gallery in a collection is cached as without it). The collection, tag and viewer are bound where Node inlines the tag and the viewer. `collectionTagId` (truthy only: `0` is none) adds `AND ci."tagId" = <tag>`. Recently Added (only beside a collection) orders `ct."collectionItemId" DESC`, the cursor on it (inclusive), so `nextCursor` is the look-ahead item's id. Each item's `collectionItemStatus` and `collectionItemAddedById` on the wire; `judgeScore` is `parseJudgeScore(note)`, answered only when it is null | not a number (`input-invalid`); `0`, a negative, a fraction or past int4 (`collection-id`); read granted only by the moderator branch (`collection-moderator`) or only by a contributor row holding VIEW (`collection-contributor`): a private collection's items are answered only to its owner; a failed permission read (the request's error); an item whose note holds a score that is not null (`collection-judge-score`); the Random sort (`input-sort`: the hourly seed and the `seed:sortKey:id` cursor); `collectionTagId` that is not an int4 integer (`collection-tag-id`: Node inlines it) or without a collection (`input-collectionTagId`: Node's BAD_REQUEST); Recently Added without one (`input-sort`); `pendingReviewOnly` (`input-pendingReviewOnly`); the gallery still falls back (`input-collectionId`) |
| Viewer | as §4 (signed out, cookie sessions, a banned session as signed out); the session's username for the own-feed rule. A verified crawler: on a Node sample (shadow, probe) the app has already decided `x-civitai-verified-bot`, read as `parseVerifiedBotHeader` reads it (`googlebot` or `bingbot`); it counts as signed in for the cap where NSFW is viewable and as signed out elsewhere, is no viewer, and is never edge-cached (createContext): the private Cache-Control. On the public route the app's policy strips the header from any user agent that is not a crawler's, so such a request is a signed-out visitor whatever it carries | as §4; on the public route a crawler's user agent (`crawler-user-agent`: only the app holds the address ranges that verify it) |
| Gates | withheld, held level, a version or post that cannot be found; moderators exempt | a held model whose settings carry no level (`held-level-unset`), a settings key Node would rebuild (`gallery-settings-miss`) |
| Tag scope | `system:blocked-browsing-tags` read from the cache cluster | that key absent (`blocked-tags-miss`) or not a `[{id}]` list (`blocked-tags-stale`): Node rebuilds it from the database |
| Pages | the feed's page and cursor, the empty-page answers; the Postgres page for a post, a collection or a model alone | a feed failure or non-200 (`feed-unavailable`, `feed-status`), a refusal Node answers with a 400 (`feed-cursor:unparsed`, `feed-offset>20000`), a feed cursor on the Postgres path (`input-cursor`), a hydrate that errors or empties the page (`feed-hydrate-error`, `feed-hydrate-empty`), a username the replica does not hold (`username-miss`) |
| Hydration | as §2 (the same `hydrate.Sources.Page`, profile pictures skipped without the include, the votable tags read only with it) | as §2 |
| Config | | no `FEED_SERVICE_URL` with the index mirror on (`index-feed-unconfigured`) |

### 14.3 Flags

| Flag | Node effect | Here |
|---|---|---|
| `image-index-feed` | the feed path for every shape `requiresImageDbPath` allows | `FEED_GO_IMAGE_INDEX_FEED` (§8) |
| `use-model-version-cache-for-images` | the prioritizedUserIds page from `imagesForModelVersionsCache` | `FEED_GO_PRIORITIZED_VERSION_CACHE` (§8; default off, as in production) |
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
- `include: ['tags']`: Node's `imageTagsCache` has a per-pod L1 (`localTtl` 15 s) this service does
  not mirror; it reads the cache cluster on every page (and keeps a computed miss in process for
  `recentTTL`). After a tag vote or edit busts the entry, a Node pod holding a copy can answer the old
  tags for up to 15 s while this service answers the new ones; a shadow diff on `items.*.tags` inside
  that window is this, not a port error.
- `followed`: Node reads the follow list twice per request (`serveImagesFromFeedService`, then the
  hydrate's `getAllImagesUncaptured`), this service once and uses it for both. A follow or unfollow
  landing between Node's two reads makes the hydrate drop (or keep) a creator the feed call named
  differently; this service's answer is the one both reads agreeing would give.

### 14.8 Serving (`FEED_GO_SERVE_INFINITE`, default off)

The same shape as `model.getAll`'s (§15.8). The public listener routes `GET /api/trpc/image.getInfinite`
to `ServeInfiniteHTTP`. With `FEED_GO_SERVE_INFINITE` off (the default) every request there is the
`infinite-off` fallback: nothing is computed, no serve slot is taken, and the request is proxied to the
Node app as it came
(`feed_go_fallback_total{feed_endpoint="infinite",mode="serve",reason="infinite-off"}`). On, the
request runs the gallery route's gates in the same order (the API request policy, the origin check, a
serve slot from the shared `FEED_GO_MAX_IN_FLIGHT` pool, the request budget) and then
`computeInfinite`; every fallback of §14.2 is proxied, as for the gallery. Cache policy: as
`computeInfinite`'s doc comment states.

Two switches gate real traffic, both off by default and each independent of the other procedures':
this one, and the web client's per-user flag that sends a signed-in browser's `image.getInfinite` to
`/api/trpc-go/image.getInfinite` (an exact-path route in front of the app rewrites that path to
`/api/trpc/image.getInfinite` on this service). The client flag alone, with this switch off, moves the
cohort through this service to the Node app unchanged.

Serve slots are shared by all three public routes. In Node `image.getInfinite` is a `heavyProcedure`
(the `heavy-image` bulkhead, as the gallery's), so here it draws on the same pool the gallery does;
`feed_go_serve_in_flight` and the `bulkhead` fallbacks are seeded at 0 for it too. Before the switch
goes on and for as long as it is on, watch them per endpoint as §15.8 says: a gallery or model
`bulkhead` rate that rises when `image.getInfinite` is served means the shared pool is too small.

## 15. `model.getAll` (tRPC, shadow; served only behind `FEED_GO_SERVE_MODEL_GETALL`, default off)

The model browse feed (`/models`, a creator's models, a tag's models): `src/server/routers/model.router.ts`
(`publicProcedure`, input `getAllModelsSchema`) → `getModelsInfiniteHandler` / `getModelsFeed`
(`src/server/controllers/model.controller.ts`) → `getModelsWithImagesAndModelVersions` → `getModelsRaw`
(`src/server/services/model.service.ts`). Ported in `internal/modelfeed`; compared at
`POST /internal/shadow/model.getAll`. The public route exists but computes nothing unless
`FEED_GO_SERVE_MODEL_GETALL` is on (§15.8). It shares the session resolver, the
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
   on the viewer's own `username`). With a `collectionId`, the viewer's read permission on the
   collection (`getUserCollectionPermissionsById`, no moderator branch): no read is an empty page
   (`isPrivate`); otherwise the query gains a `CollectionItem` semi-join. The query: `ModelMetric`
   joined to `Model`, or, with
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
names and creators are the common shapes and are ported; a collection, the largest fallback measured
after them, is ported too (§15.2.1), and so is Hot with a base-model filter, the largest left after
that (the official-checkpoint pin, §15.2.2); every other unsupported key is rare. A ported shape can still fall back on
a cache miss. In shadow that is not measured: the sample is computed after Node answered the same
request and filled every key it read, so the shadow's miss fallbacks undercount the misses a Go-first
read would see. Serving needs a Go-first miss measurement and Go-side miss filling first (§3).

| Area | Ported | Falls back (reason) |
|---|---|---|
| Input | every sort but Recently Added; `period` / `periodMode`; `limit`; the keyset cursor; `types`, `checkpointType`, `baseModels`, `tag` / `tagname`, `username` / `user`, `fileFormats`, `fromPlatform`, `earlyAccess`, `paidAccess`, `hidePaid`, `onSale`, `archived`, the licensing filters, `excludedTagIds`, `excludedUserIds`, `disablePoi`, `disableMinor`, `collectionId` with `collectionTagId` (§15.2.1); Hot with a base-model filter (the official-checkpoint pin, §15.2.2) | `query` (Meilisearch), `hidden`, `followed`, `newCreators`, `ids`, `modelVersionIds`, `status`, `needsReview`, `pending`, `supportsGeneration`, `isFeatured`, `availability`, `publishedFrom` / `publishedTo`, `poiOnly` / `minorOnly`, `page` (`input-<key>`); Recently Added, with or without a collection (`model-sort-recently-added`); a `collectionId` or `collectionTagId` that is not an int4 integer (`model-collection-id`; not a number, `null` included, is `input-invalid`); a cursor Node answers with a 400, or a date token not in Postgres' CONCAT form (`model-cursor`); `ids` present at all, `[]` and `""` included (`input-ids`) |
| Viewer | as §4 | as §4; a signed-in request with no level (`model-level-absent`: the saved level is not read) |
| Flags | the state production runs (§15.3) | any model flag mirror off (`flag-off-state`) |
| Lookups | the tag by name and the creator by name on the replica; the blocked tag list; the collection read permission on the replica | a creator the replica does not hold (`model-username-miss`: Node reads the primary, then 404s); the blocked list absent or unreadable (`blocked-tags-miss`, `blocked-tags-stale`) |
| Caches | basic users, profile pictures, cosmetics and tags by id on a miss (the replica); privacy defaults on a miss (`User.settings` on the replica); computed misses (§3.1) on the model data, the model tags, the model frames, the model hats, the version showcases and the showcase images' tag ids; the official models (§15.2.2) | misses on user cosmetics and memberships (`user-cosmetics-miss`, `membership-miss`), and on the model data, model tags, model frames, model hats, version showcases, image tags and the official models without the computation (`model-data-miss`, `model-tags-miss`, `model-frame-miss`, `model-decoration-miss`, `model-images-miss`, `tag-ids-miss`, `official-models-miss`); a failed miss computation (`<reason>-failed`); a gallery-settings key Node would rebuild (`gallery-settings-miss`, `gallery-settings-stale`); a held setting with no level (`model-held-level-unset`) |

### 15.2.1 Collections

`getModelsRaw` with a `collectionId` (truthy: 0 is no filter), after the tag and creator lookups and
before the cursor is parsed, as Node orders them (`internal/modelfeed/collection.go`, `servePage`):

- **Read.** `getUserCollectionPermissionsById({ userId, id })`, called without `isModerator`: a
  collection reads when its `read` is Public or Unlisted, when the viewer owns it, or when the
  viewer's `CollectionContributor` row holds VIEW. A missing collection reads for no one. No read is
  `{ items: [], nextCursor: undefined }` with no page query, whatever the cursor (Node returns before
  parsing it). One indexed read of the `Collection` row (with the viewer's contributor row when signed
  in) on the replica, on every page of the loop, as Node reads it on every `getModelsRaw` call.
- **Items.** `getAvailableCollectionItemsFilterForUser` without `statuses` (model.getAll never passes
  them; `collectionItemStatus` is ignored): `ACCEPTED` items, and for a signed-in viewer also the
  `REVIEW` items they added, as `EXISTS (SELECT 1 FROM "CollectionItem" ci …)` on `mm."modelId"`,
  narrowed by `collectionTagId` when it is set. Every sort, filter, base-model path and the keyset
  cursor apply as without a collection; Recently Added (the `JOIN` ordered by `ci."id"`) falls back.
- **Versions.** A collection turns `hidePrivateModels` off: Private versions are listed.
- **Cache policy.** Unchanged: Node's `isPrivate` sets `canCache = false` on the copy of `ctx.cache`
  `skipEdgeCache` hands the handler, which no header reads (its comment in `model.router.ts`), so a
  signed-out answer stays public and a session's private. A signed-out viewer reads no private
  collection, so nothing private reaches a shared cache.

### 15.2.2 The official-checkpoint pin

`getModelsFeed` with `sort: Hot`, a non-empty `baseModels` and no `query` (a query falls back before
this) leads the first page with the official checkpoints and drops them from every page
(`internal/modelfeed/serve.go` `Serve`, `internal/hydrate/official.go`):

- **The ids.** `getOfficialModelIds` (`src/server/services/resource-select.service.ts`):
  `fetchThroughCache(OFFICIAL_MODELS, …, { ttl: 300, retryCount: 0 })` over
  `dbRead.model.findMany({ where: { isOfficial: true, status: Published }, select: { id, type } })`,
  one key `packed:caches:official-models` holding `{data: [{id, type}], cachedAt: <epoch ms>}`, then
  the controller keeps the `Checkpoint` ones, in the cached order. A fresh entry (`cachedAt` within
  the 5 min ttl) is used as is. Otherwise feed-go does what `fetchThroughCache` does: with write-back
  on it takes the same refresh lock (`cache-lock:<key>`, SET NX EX 10), reads the replica, writes the
  entry (SET EX 600, plain, as Node's under its lock) and releases the lock; a lock held elsewhere
  serves the expired entry, or with none answers no pin (Node's `retryCount: 0` throws and
  `getOfficialModelIds`' catch answers `[]`); a failed lock write serves the expired entry or reads
  the replica without writing; a failed cache read reads the replica without writing (Node's
  fail-open path). With write-back off (and under the Go-first probe) nothing is written and no lock
  is taken: the lock is only read (EXISTS) and answered as above, and a free lock means a replica
  read, kept in process for 10 s (`lookupShared`). A replica read that fails falls back
  (`official-models-miss-failed`); without the miss computation an entry that would be read falls
  back (`official-models-miss`).
- **First page** (no cursor). One `getModelsWithImagesAndModelVersions` call restricted to the
  pinned ids (`mm."modelId" = ANY(…)`, Node's `IN (…)`), with take = their count and every other
  filter, the base-model path and the hydration of any page; its lookahead cursor is not read, and
  its items lead the answer and do not count towards `limit`. A pinned id with no row on this base
  is simply absent.
- **Every page of the loop** (the first included) drops the pinned ids (`mm."modelId" != ALL(…)`,
  Node's `NOT IN (…)`), so a cursor never re-emits them; a later page (a cursor) runs no pinned page.
  Neither filter relaxes the private-model filter. The answer's `nextCursor` is the main loop's.

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
are cache entries, emitted in their cached key order (§5).

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
- cache staleness: a stale-while-revalidate entry (basic users, cosmetics, tags) is served here where
  Node, holding the refresh lock, would read it again (the version showcases are revalidated as Node
  does with the miss computation on, §3.1);
- the metric-privacy defaults are read for every row's owner (Node reads the shown models' owners):
  extra reads, the same answer;
- the creator lookup reads the replica only (Node reads the primary next);
- the computed model data and model tags (§3.1) read the same statements as Node's lookups, none of
  which orders the hashes or the tag ids (and the versions only by model and `index`): both sides
  get the database's order for the same plan, which SQL does not promise, so the `hashes` and `tags`
  arrays (and versions sharing an `index`) of a computed miss may be ordered differently from a
  value Node computed at another moment. With write-back on the value Go writes is what both then
  serve;
- with write-back off the model-data lookup reads the replica even for a model a recent write
  flagged (Node would read the primary): only that answer is affected, nothing is written;
- the official models with write-back off: the refresh lock is read, not taken, so two processes can
  both read the replica where Node would let one; a failed replica read falls back where Node's
  catch would answer the page without the pin;
- the blocked tag list is memoized for 30 s as Node memoizes it per pod, in the one memo image.getInfinite
  reads (`feed.BlockedTags`); the two memos refresh at different moments, so a changed list can reach
  this service and a Node pod up to 30 s apart;
- a cursor's date token is read in Postgres' own `CONCAT` form only; any other spelling dayjs accepts
  falls back;
- the collection read permission: Node's read also joins the viewer's accepted invite, which feeds
  only `isCollaborator`, not `read`; it is not read here;
- `ids` falls back whenever it is present, empty included: Node reads `[]` as `[]` and `""` as `[0]`,
  both truthy, so either turns off the private-model filter;
- `canGenerate`, `isMatureRestricted` and the level constants come from `internal/modelfeed/basemodels.json`,
  generated by `scripts/feed-go-basemodels.ts` from the Node functions and held to them by
  `scripts/__tests__/feed-go-basemodels.schema-drift.test.ts`: a constants change that is not regenerated fails CI.

### 15.8 Serving (`FEED_GO_SERVE_MODEL_GETALL`, default off)

The public listener routes `GET /api/trpc/model.getAll` to `ServeModelGetAllHTTP`. With
`FEED_GO_SERVE_MODEL_GETALL` off (the default) every request there is the `model-getall-off` fallback:
nothing is computed, no serve slot is taken, and the request is proxied to the Node app as it came
(`feed_go_fallback_total{feed_endpoint="model-getall",mode="serve",reason="model-getall-off"}`). On,
the request runs the gallery route's gates in the same order (the API request policy, the origin
check, a serve slot from the shared `FEED_GO_MAX_IN_FLIGHT` pool, the request budget) and then
`computeModelGetAll`; every fallback of §15.2 is proxied, as for the gallery.

Cache policy: as `computeModelGetAll`'s doc comment states (the shadow compares the header like the
gallery's).

Two switches gate real traffic, both off by default: this one, and the web client's per-user flag that
sends a signed-in browser's `model.getAll` to `/api/trpc-go/model.getAll` (an exact-path route in front
of the app rewrites that path to `/api/trpc/model.getAll` on this service). The client flag alone, with
this switch off, moves the cohort through this service to the Node app unchanged.

Serve slots are SHARED: every public route (since §14.8, three) draws on the one `FEED_GO_MAX_IN_FLIGHT` pool (for the
gallery it stands in for Node's `heavy-image` bulkhead; Node has no bulkhead on `model.getAll`), so a
burst on one route makes the other shed. `feed_go_serve_in_flight` is labelled by the route holding
the slot, and both endpoints' series and `bulkhead` fallbacks are seeded at 0. An answer that loaded
no model row is counted `served_empty`, as in the shadow (§15.6).

Rollout step, before the switch goes on and for as long as it is on: watch the `bulkhead` fallbacks
per endpoint, `sum by (feed_endpoint) (rate(feed_go_fallback_total{mode="serve",reason="bulkhead"}[5m]))`,
with `sum by (feed_endpoint) (feed_go_serve_in_flight)`. A gallery `bulkhead` rate that rises when
model.getAll is served means the shared pool is too small for both: turn the switch off and size it
first.

## 16. `GET /api/v1/models` and `GET /api/v1/models/[id]` (REST, shadow; served only behind `FEED_GO_SERVE_V1_MODELS`, default off)

The public model API: `src/pages/api/v1/models/index.ts` (a `MixedAuthEndpoint`) → `runModelSearch`
(`src/server/services/model-search.service.ts`), and `src/pages/api/v1/models/[id].ts` (a
`PublicEndpoint` behind `withBlockScope`) → `buildPublicModelResponse`. Both build on
`getModelsWithVersions` over `getModelsRaw` (`src/server/services/model.service.ts`). Ported in
`internal/v1models`; compared at `POST /internal/shadow/api/v1/models` and
`POST /internal/shadow/api/v1/models/id`. The public routes exist but compute nothing unless
`FEED_GO_SERVE_V1_MODELS` is on (§16.8).

### 16.1 What the Node path does

1. **Query.** The list parses `modelsEndpointSchema` off `req.query` (`limit` 0–100, default 100;
   `page`; `cursor`; `query`; `types`; `sort`, default Highest Rated; `period`, default AllTime;
   `periodMode`; `baseModels`; `username` through `postgresSlugify`; `nsfw`, `primaryFileOnly` and the
   other `booleanString()`s; `ids`; …). A signed-out caller naming `favorites` or `hidden` is a 401;
   `page * limit > 1000` without a cursor a 429; `query` with `page` a 400. `[id]` parses only the path
   id (`z.coerce.number().int().gt(0).lte(INT4_MAX)`).
2. **Viewer and level.** The list reads a session or an API key; `[id]` reads neither (a block JWT
   only skips the origin cache). The level is `nsfw ? all : PG` on the list, all on `[id]`, PG/PG-13
   in a restricted region on both. No domain cap.
3. **Text search.** A truthy `query` asks Meilisearch for the page's ids (`resolveModelSearchIds`).
   `query` is `z.string().optional()` (no trim), so only the empty string (`?query=`, `?query`) is
   falsy: the handler then takes the database path exactly as with no `query` (cursor and skip kept,
   no `query && page` 400), and `nextPage` leaves the empty value out (QS.stringify's
   `skipEmptyString`). A repeated `query` is an array, a 400.
4. **The model statement.** `getModelsRaw` resolves the browsing-settings addons at the level
   (`enforceBlockedBrowsingTagsForModels`; `[id]` keeps only `disablePoi`; a `tagname ?? tag` whose
   lowercased name is a blocked browsing tag's answers an empty page there, before any other read),
   looks a `tag` up by its exact name on the replica (`EXISTS` on `TagsOnModels` when found, no
   clause when not), then one statement on the
   replica: `ModelMetric` × `Model` (or one of the three `ModelBaseModelMetric` forms when
   `baseModels` is set and `base-model-feed-metrics` is on), the filters, the sort's ORDER BY and the
   keyset cursor (`getCursorClauses`: a UNION ALL of the equality and the tuple branch for a
   DESC-headed sort, else the OR-chain), `LIMIT take + 1`. The lookahead row's `cursorId` is
   `nextCursor`.
5. **Per model.** Creators (`userBasicCache`, profile pictures), the model data cache (versions,
   their tags from `modelTagCache` → `tagCache`), live paid-access gates; the versions filtered
   (Published, mature versions on a mature-restricted base model, Public only without `ids` or
   `username`, the requested base models), the .com face at an SFW-only level, the addon tags.
6. **Per version.** Paid access (the paid-access cache), showcase images (the images-for-version
   cache, held to a minor/SFW-only model's gallery level, then the showcase filter: the addons' POI,
   minor and tag exclusions), files (the files-for-version cache) plus a linked VAE's primary files
   (replica), model and version metrics and version meta (replica), and the creator's metric
   privacy (cache, then replica) gated on a valid Creator Program membership (cache).
7. **Shaping.** The list (`runModelSearch`) and `[id]` (`buildPublicModelResponse`) differ: `[id]`
   applies `removeEmpty` to each version and file metadata, pins each owned file's download URL with
   `fileId`, drops image `id`s and uses `getBaseUrl()` for download URLs; the list keeps nulls and
   empty arrays, uses the request origin, and passes every image through on `nsfw=true`. Both pick the
   primary file by the default preferences (a version without one is dropped), name each file
   (`resolveModelFileName`), build edge URLs, and leave Training Data files to
   `trainingDataListing`.
8. **Body.** `res.json`: the list `{ items, metadata: { nextCursor, nextPage, currentPage?, pageSize? } }`
   (`nextPage` is the request's query with `cursor` set, on `https://<host>` in production — `page`
   never advances); `[id]` the model object, from the origin response cache
   (`packed:caches:public-model-response:v2:<id>:<level>`, 180 s) when fresh.

### 16.2 What is ported, and what falls back

| Area | Ported | Falls back (reason) |
|---|---|---|
| Query | every key above except those on the right; an empty `query` (falsy: the database path); `tag` (ASCII); unknown keys ignored and kept for `nextPage` | a truthy or repeated `query` (`v1-models-query`: Meilisearch), a non-ASCII `tag` or a blocked list holding a non-ASCII name (`v1-models-tag`: Go's lowercasing of such text is not always JS's `toLowerCase`), no cached blocked list (`blocked-tags-*`), every other schema key (`v1-models-<key>`: `tagname`, `supportsGeneration`, `checkpointType`, …), a signed-out `favorites`/`hidden` (`v1-models-authed-only`), `limit=0` or over 100 (`v1-models-limit`), the 429 (`v1-models-page-limit`), a Recently Added or unknown sort (`v1-models-sort`), a value `Number()` or zod reads otherwise (`v1-models-input-*`), a cursor Node answers with a 400 or reads through JS's Date parser (`v1-models-cursor`) |
| Viewer | the list signed out; `[id]` always (it reads no session) | a list session (`v1-models-session`); API credentials (`bearer-token`; the sampler never sends them) |
| Statement | all four FROM forms, every sort but Recently Added, both cursor forms, the period bound, types, base models, username, `tag` (the blocked-name empty page, the Tag lookup, its `EXISTS`), ids, earlyAccess, archived, the addons' POI/minor/tag clauses | a username the replica does not hold (`v1-models-username-miss`) |
| Caches | every hit; the paid-access and metric-privacy misses (their lookups are plain replica reads); a tag-name miss with `FEED_GO_COMPUTE_MISSES` (tagCache's lookup, §16.7) | a model-data, model-tags, images, files or membership miss (`v1-models-*-miss`), a tag-name miss with `FEED_GO_COMPUTE_MISSES` off, a stale images/files/tag entry Node would revalidate (`v1-models-*-stale`), a gallery-settings key Node would rebuild (`gallery-settings-miss`), a held model whose settings carry no level |
| Shaping | both shapers, the file naming over ASCII model names | a Public Training Data file (`v1-models-training-data`), a name the scheme strips non-ASCII text from (`v1-models-filename`) |
| Config | | no `NEXT_PUBLIC_IMAGE_LOCATION` or (`[id]`) `NEXTAUTH_URL` (`v1-models-unconfigured-urls`) |

### 16.3 Flags and settings

| Flag / setting | Node effect | Here |
|---|---|---|
| `generation-coverage-next` | which coverage column `supportsGeneration` reads | `FEED_GO_GENERATION_COVERAGE_NEXT`, the mirror model.getAll reads (§15.3; default on, its production value) |
| `base-model-feed-metrics` | the base-model statement forms | `FEED_GO_BASE_MODEL_FEED_METRICS`, likewise shared with §15.3 (default on) |
| `IS_DATAPACKET` | the `[id]` origin cache (180 s) | `FEED_GO_MODEL_RESPONSE_CACHE` (default on): read, never written |
| `kysely-hot-reads-11`, `model-version-images-skip-tags` | the same rows by another route; an entry-level field no consumer reads | nothing to do |
| `NEXTAUTH_URL`, `NEXT_PUBLIC_IMAGE_LOCATION` | download and edge URL prefixes | the same variables |

### 16.4 The Node sampler (flag `feed-go-shadow-v1-models`, default OFF)

One flag for both routes, sampled through the REST sampler of §13.4 (`beginFeedGoShadowV1Models`,
`captureFeedGoShadowRest`), with its own per-second bucket per route and the shared rate and
in-flight cap. A request with an API credential is counted (`skipped_credential`) and never sent.
The list route does not sample a text `query` or a signed-in caller: feed-go answers every one of
them with a fallback (`v1-models-query`, `v1-models-session`). An empty `query` is falsy to the
sampler's `query || user` test as to the handler, so it is sampled, and answered here. Both routes finish every sampled
request in a `finally`, so one that answers other than 200 is counted `skipped_status`. The sample
carries the response's headers of `FEED_GO_COMPARED_REST_RESPONSE_HEADERS`, marked
`responseHeaderSet: "rest"` (§16.8).
Outcomes are `civitai_app_feed_go_shadow_samples_total{feed_endpoint="v1-models"|"v1-models-id"}`.

### 16.5 Comparison and measurement

`shadow.CompareJSON` as in §13.5. The list classifies by `items[].id` (models); `[id]` has one model,
so a difference is `fields`, and a not-found answer against Node's 200 is `membership`. The response
headers compare as their own result (§7, `feed_go_shadow_response_total`), against the headers the
public route writes (§16.8).

The `[id]` origin cache: on a miss Node builds the body and awaits its write before answering, and
the sample is posted only after the answer, so reading the cache here would mostly find the entry
Node wrote for the sampled request and compare Node's answer with itself. An entry younger than
`v1models.NodeBuiltWindow` (15 s) is therefore ignored and the body built: Node's side was a build
(of this request, or of one at most 15 s earlier), so the comparison measures the port, and it is
counted as a build (`served` / `match`). The window covers the longest sample timeout
(`FEED_GO_SHADOW_TIMEOUT_MS`, at most 10 s) plus the compare queue. An older entry is one Node also
served from the cache: it is read, compute outcome `served_cached` and result `match_cached`, kept
apart from `served`/`match` like a trivial answer (§13.6) since it costs a cache read on both sides. Read
the go/no-go per endpoint with §13.6's queries and `feed_endpoint="v1-models"` or `"v1-models-id"`.

### 16.6 Parity evidence

The golden fixtures (`testdata/golden/v1-models`, written by `gen-v1-models.mjs`) hold a request and
the world it reads. `src/server/__tests__/feed-go-v1-models.golden.test.ts` runs the REAL route
handlers over each world (only I/O mocked: the model statement, the caches' fetch, the small replica
reads) and requires the fixture's `expect.body` to be the exact bytes `res.json` writes and
`expect.sql` the statement it builds; `internal/v1models/golden_test.go` requires the same bytes and
the same statement (text and bound values) from Go.

### 16.7 Known divergences

- response headers (§16.8): the sampler forwards only the `civ-token` session cookies, so a sample
  whose only session cookie is the legacy next-auth one reads as cookieless here while Node chose its
  credentialed Vary: a `header:vary` mismatch the shadow cannot avoid (the served path sees the real
  Cookie header and computes the same Vary as Node, or falls back on the list);
- the download file name of a model or version name with non-ASCII text falls back
  (`v1-models-filename`): `resolveModelFileName` strips the model name out of the version name with
  `new RegExp(…, 'gi')`, whose case-insensitive match (non-Unicode mode) canonicalizes each UTF-16
  unit with the engine's `toUpperCase`. That is the running Node build's ICU case table, a newer
  Unicode version than Go's `unicode` package carries, and a golden fixture pins it for one Node
  build only; ASCII text, where both agree, is ported;
- `superjson.Plain` escapes U+2028/U+2029 where `JSON.stringify` writes them raw (same decoded
  value; the comparator decodes);
- a cursor timestamp's fraction is padded to three digits before it is read, as parseCursor's
  `normalizeCursorTimestamp` does (`.25` is 250 ms); a date-like token outside that
  `YYYY-MM-DD HH:mm:ss.f` shape keeps dayjs's own reading of the fraction as a millisecond count;
- the caches are read, never refilled or revalidated, and the answer serves what Node's cache held
  milliseconds earlier (`stats.*` and `nextCursor` noise on busy lists). A stale entry Node would
  revalidate falls back. Per cache, a miss:
  - tag names (`basic-tags`): with `FEED_GO_COMPUTE_MISSES` (§3.1) named by tagCache's own lookup on
    the replica (`SELECT id, name FROM "Tag"`), nothing written back; off, it falls back;
  - model data (`data-for-model-2`): falls back. Its lookup is lag-aware (it may read the primary
    after a recent version change); model.getAll computes it with `FEED_GO_COMPUTE_MISSES` (§3.1),
    this endpoint does not yet;
  - model tags (`model-tags`): falls back. Its lookup reads `TagsOnModels` with no ORDER BY, so the
    tag order Node writes is the replica's row order, which a second read cannot be held to
    (model.getAll computes it, documenting that order as a divergence, §15.7);
  - version images (`images-for-model-version-2`): falls back here (model.getAll computes it with
    `FEED_GO_COMPUTE_MISSES`, §3.1);
  - version files (`files-for-model-version-2`): falls back. Its lookup joins files, hashes and
    metadata (`fetchModelFilesForCache`); no Go port exists;
  - creator membership (`creator-membership-valid`): falls back. Its origin parses subscription
    products with the app's tier key (as model.getAll's does).

### 16.8 Serving (`FEED_GO_SERVE_V1_MODELS`, default off) and the response headers

**Routes and switch.** With `FEED_GO_V1_FALLBACK_URL` set, the public listener routes
`GET /api/v1/models` to `ServeV1ModelsHTTP` and everything under `/api/v1/models/` to
`ServeV1ModelsIDHTTP` (`internal/server/v1models_serve.go`); unset, those paths are not mounted.
With `FEED_GO_SERVE_V1_MODELS` off (the default) every request there is the `v1-models-off` fallback:
nothing is computed, no serve slot is taken, and the request is proxied as it came
(`feed_go_fallback_total{feed_endpoint="v1-models"|"v1-models-id",mode="serve",reason="v1-models-off"}`).
The switch on without `FEED_GO_V1_FALLBACK_URL` fails startup.

**The fallback upstream.** The Node pool that answers `/api/v1` today is not the one behind
`FEED_GO_FALLBACK_URL` (the tRPC routes'), so the model routes proxy to their own upstream,
`FEED_GO_V1_FALLBACK_URL`, with the same proxy (`cmd/feed-go/proxy.go`: original Host and query,
forwarding headers, its own idle pool, `feed_go_fallback_proxy_errors_total`). Its value is
deployment config. Every answer carries `X-Feed-Go-Served` (`go` or `node`), as on the tRPC routes.

**The gates, in order** (the model.getAll route's, §15.8, for a REST answer):

1. The API request policy (§6.2): a blocked region is `region-blocked` and the Node app answers its
   own 451; a crawler's user agent is `crawler-user-agent`. There is no origin check: the REST routes
   answer any origin (`Access-Control-Allow-Origin: *`).
2. A serve slot from the one shared pool (`FEED_GO_MAX_IN_FLIGHT`, §6.1; `bulkhead` past it), and the
   request budget (`deadline`), as every public route; `feed_go_serve_in_flight` and the `bulkhead`
   series are seeded per model endpoint. A client that leaves is `canceled` and not proxied.
3. The checks no Node read can answer (`v1ModelsPreflight`), before the port runs: not a GET
   (`method`); any API credential, an Authorization header of any value or a `?token=`
   (`bearer-token`); a conditional request, `If-None-Match` or `If-Modified-Since`
   (`v1-models-conditional`: Next's `res.json` answers a matching one 304); on the list, a cookie under
   any session cookie name, the legacy next-auth one included, valid or not
   (`v1-models-session-cookie`: the list serves signed-out callers only) and an `etag` query value
   (`v1-models-etag`: MixedAuthEndpoint checks it against the database and may add X-Expires); on
   `[id]`, an `Origin` header (`v1-models-origin`: withBlockScope adds its CORS headers for an origin
   on the block-app allow-list, which lives in the database).
4. The port, with every fallback of §16.2 (unsupported inputs, cache misses, a list session); serving,
   `[id]` reads every origin cache entry within its TTL as Node's handler does (the shadow alone skips
   one younger than `NodeBuiltWindow`, §16.5), and a not-found `[id]` falls back
   (`v1-models-not-found`: Node's answer is a 404, an answer here is a 200).
5. The body as `JSON.stringify` writes it (`v1models.NodeBody`: the plain writer's `\u2028` /
   `\u2029` escapes written raw); a body holding an escaped U+FFFD (an invalid UTF-8 byte) has no
   known `JSON.stringify` text and falls back (`v1-models-invalid-utf8`).

An answer is that body with the headers below, Next's `Content-Type: application/json;
charset=utf-8`, and `X-Feed-Go-Served: go`, counted `served`, `served_empty` (an empty page) or
`served_cached` (`[id]` from the origin cache).

**The response headers** (`v1models.ResponseHeaders`, the one function the public route writes and the
shadow compares). They drive Cloudflare's caching of the public API, so each is Node's, from the place
Node sets it:

| Header | Value | Set by (Node) |
|---|---|---|
| `X-Frame-Options` | `DENY` | next.config.mjs `headers()` (`/((?!gift-cards).*)`), applied by the router before the route; `internal/v1models/configheaders.json`, held to the real config by `src/server/__tests__/feed-go-v1-models-config-headers.test.ts` |
| `Vary` | `Authorization`; `Authorization, Cookie` when the request presented a credential (`requestCarriesCallerCredentials`: Authorization, a session cookie name, `?token=`) | `MixedAuthEndpoint` / `PublicEndpoint`, `src/server/utils/endpoint-helpers.ts` (`ANONYMOUS_VARY` / `CREDENTIALED_VARY`) |
| `Access-Control-Allow-Origin` | `*` | `addCorsHeaders` (no `allowCredentials`), same file |
| `Access-Control-Allow-Headers` | `Authorization, Content-Type, *` | `addCorsHeaders` (`CORS_ALLOW_HEADERS`) |
| `Access-Control-Allow-Methods` | `GET` | `addCorsHeaders` |
| `Cache-Control` (list) | `public, s-maxage=300, stale-while-revalidate=150` with no credential and no verified crawler, else `max-age=0, private, no-cache`; `private, no-store` with `nsfw` | `MixedAuthEndpoint` (`addPublicCacheHeaders`, `PRIVATE_CACHE_CONTROL`), then `src/pages/api/v1/models/index.ts` (`nsfw`) |
| `Cache-Control` (`[id]`) | `private, no-store` | `src/pages/api/v1/models/[id].ts`, on every request that parsed, over `PublicEndpoint`'s |
| `ETag` | Next's `generateETag` over the body string (FNV-1a 52 over its UTF-16 code units, then its length, base 36) | Next's `res.json` → `sendData` (`next/dist/server/api-utils/node/api-resolver.js`) |

The proxy's own default `Cache-Control` (`apiCacheMiddleware`) is always overwritten by the wrapper;
its `X-Handled-By` (the pod) is not reproduced. A verified crawler is read only on a shadow sample
(the app's own decision, §6.2); a public request from a crawler's user agent is handed to the app.

**Parity evidence.** `testdata/golden/v1-models-headers` (written by `gen-v1-models-headers.mjs`)
holds one case per header arm over a §16.6 body fixture, with extra request headers. The Node golden
test runs each case through the REAL endpoint wrappers (MixedAuthEndpoint, PublicEndpoint,
withBlockScope) and handlers and requires exactly the headers the route set, plus the ETag Next's own
function gives the body; `internal/v1models/headers_golden_test.go` requires the same from Go over the
same world. The ETag is also pinned on literal strings Next's function hashed
(`TestETagIsNextsGenerateETag`).

**The shadow.** The sampler forwards a REST sample's headers of
`FEED_GO_COMPARED_REST_RESPONSE_HEADERS` (`shadow.RESTComparedHeaders`: §7's list plus `etag`, the
three `access-control-allow-*` headers, `access-control-expose-headers`, `x-frame-options` and
`x-expires`), marked `responseHeaderSet: "rest"`; a sample without the mark (a sampler that predates
it) is compared over §7's list only. The allow-headers, allow-methods and expose-headers lists compare
as sets, `x-frame-options` case-insensitively, the ETag exactly. A sample is marked as one, so its
verified-crawler header is read (above).

**Kill and routing.** The kill is the switch: `FEED_GO_SERVE_V1_MODELS` off proxies every request
again, with nothing computed. Routing public traffic to these paths (a weighted ingress route in the
infrastructure repo) is a separate step from this switch; with the switch on and no route, nothing
is served. Before the switch goes on and while it is on, read the `bulkhead` fallbacks per endpoint
as §15.8 says (the pool is shared with the tRPC routes), and `feed_go_shadow_response_total` for both
model endpoints alongside the body match rate.

## 17. `model.getAssociatedResourcesCardData` (tRPC, shadow only)

A model page's Suggested Resources cards: `src/server/routers/model.router.ts` (`publicProcedure`,
input `getAssociatedResourcesSchema`, the `associationSourceVisible` middleware) →
`getAssociatedResourcesCardDataHandler` (`src/server/controllers/model.controller.ts`). Ported in
`internal/modelfeed/assoc*.go`, wired in `internal/server/associated.go`, compared at
`POST /internal/shadow/model.getAssociatedResourcesCardData` (`feed_endpoint="model-associated"`).
No public route and no Go-first probe: a probe needs a case in the server's golden probe harness
(`internal/server/probe_test.go`), which these fixtures are not in yet.

### 17.1 What the Node path does

1. **Levels.** `applyDomainFeature` on the raw input (`stripBlockedForNonModerator`, the domain
   clamp); then the schema's `browsingLevel` default (`allBrowsingLevelsFlag`). No saved level is
   read. The schema keeps `fromId`, `type` (`Suggested`) and `browsingLevel`; zod strips the rest.
2. **Source visibility.** Not for a moderator or `fromId` 0: the source model's `poi` and owner; a POI
   model is its owner's and moderators' (`canViewPoiModel`), anyone else gets NOT_FOUND.
3. **Targets.** The `ModelAssociations` rows of the source and type, by `index`; a falsy `toModelId`
   is an article card (`getArticles`). With `type` Suggested, `getSponsoredModel` may put a paid run
   in the second slot (`creator-promotions`).
4. **Models.** `getModelsRaw` with `ids` (so Private versions are listed), the default sort, no
   `take` (at most 101 rows, none popped), no `include` (no frames or event hats). Its addon
   resolution mutates the handler's `modelInput`, so the image read sees the same exclusions.
5. **Images.** `getImagesForModelVersion` over every item's shown version: one image per version,
   viewer-specific (`blockedFor`, the minor content rule, `modelRestricted`, the excluded tags, the
   level), no tags, no meta, rows untrimmed. Then `associatedCardImages`: the showcase hold
   (`holdShowcaseImages`, owner exempt, moderators skip it) and `filterImagesForViewer` at every level.
6. **Cards.** Per item: dropped with no image; `canGenerate` from `resolveCanGenerateForVersions`
   (`getResourceCanGenerate` with the hidden gate rules, `isGenerationEligible`, a Wildcards
   version's own gate); metric privacy as model.getAll's; a taken-down model keeps its card with
   `images: []`.
7. **Answer.** The association order (a repeated id repeats the card), without models the page query
   did not return and without owners in the viewer's `HiddenUsers` / `BlockedByUsers` /
   `BlockedUsers` caches (user `-1` signed out); each card `{ resourceType: 'model', ...model, tags,
   hashes, hiddenMetrics, rank, images, canGenerate, version, sponsored }`.

### 17.2 What is ported, and what falls back

| Area | Ported | Falls back (reason) |
|---|---|---|
| Input | `fromId` (int4), `type`, `browsingLevel`; the client keys `authed` / `direction` | any other key (`input-unknown-key`); a value the schema refuses, a fractional or out-of-int4 `fromId`, a non-numeric or negative `browsingLevel` (`input-invalid`) |
| Viewer | as §4 | a banned session (`model-assoc-banned-session`); a POI source for a viewer who may not see it (`model-assoc-source-hidden`: Node's 404, never sampled) |
| Targets | model associations | an article among them (`model-assoc-articles`); more than 100 distinct models (`model-assoc-many`); with `creator-promotions` not known off for the viewer (`FEED_GO_CREATOR_PROMOTIONS`, as §8), any approved model-card run on the source resolved within 7 days, live or not (`model-assoc-sponsored`: Node picks one at random) |
| Caches | model.getAll's (§15.2), including the misses it computes; the hidden-preferences hash | a missing hidden-preferences field (`model-assoc-hidden-prefs-miss`: Node reads the database and writes it); the gallery-settings and held-level fallbacks of §15.2 |
| canGenerate | coverage (`generation-coverage-next` mirrored by `FEED_GO_GENERATION_COVERAGE_NEXT`, both states), the explicit-coverage versions, Private versions, `hidden` gate rules on version ids for moderators / nobody / signed out testers | a shown Wildcards card (`model-assoc-wildcards`); the gate rules unmigrated or unreadable (`gate-rules-unmigrated`, `gate-rules-unreadable`); an applicable `hidden` rule naming an ecosystem (`gate-rules-ecosystem`: the base model's ecosystem key is not held here); a `hidden` testers rule naming a shown version or an ecosystem, for a signed-in non-moderator (`gate-rules-testers`: testing access is a per-user Flipt answer) |

### 17.3 Sampler, comparison, measurement

The Node sampler (`src/server/trpc/feed-go-shadow.ts`) mirrors the procedure under its own flag,
`feed-go-shadow-model-associated` (default off), with the shared URL, sample rate and in-flight cap
and its own per-second bucket. The comparison is §7's over an array: `shadow.ClassifyArray` keys the
cards by `id`; categories are `*.<field>`. An answer that loaded no model row is `served_empty` /
`match_empty`.

**Signed-in coverage.** A signed-in browser batches the procedure when `trpcBatching` is on for it,
and the sampler never samples a batched call, so the shadow sees anonymous sessions and signed-in
sessions with batching off only. Each compared sample is therefore also counted by its viewer class,
`feed_go_shadow_compare_viewer_total{feed_endpoint="model-associated",viewer,result}`, with `viewer`
one of `anon`, `user`, `owner` (the source model's owner) and `moderator` (`modelfeed.ViewerClasses`,
a fixed set, each seeded at 0 for `match`). The serve gate requires a minimum number of compared
samples in every class, not only an overall match rate.

🔴 **Serving this procedure is blocked** until one of these holds: signed-in calls are sampled (a
per-call capture inside a batch, or a signed-in cohort with batching off), or the serving transport
takes unbatched calls only, so every call Go would serve is a shape the shadow measured.

```promql
sum by (viewer) (increase(feed_go_shadow_compare_viewer_total{feed_endpoint="model-associated"}[7d]))

sum(rate(feed_go_shadow_compare_total{feed_endpoint="model-associated",result="match"}[1h]))
  / sum(rate(feed_go_shadow_compare_total{feed_endpoint="model-associated",result=~"match|fields|order|membership"}[1h]))

topk(10, sum by (reason) (rate(feed_go_fallback_total{feed_endpoint="model-associated",mode="shadow"}[1h])))
```

### 17.4 Parity evidence and known divergences

`testdata/golden/model-assoc` (written by `gen-assoc.mjs`, README "model-assoc"), run by
`internal/modelfeed/assoc_golden_test.go`. Divergences:

- those of §15.7 that apply (timing, cache staleness, the replica-only reads);
- `isBaseModelGenerationDisabled` is its own list in `basemodels.json` (`generationDisabled`, from the
  Node function), read with `.some` semantics: a base model with a later disabled generation override
  does not generate, as in Node;
- the two explicitly covered version ids are constants transcribed from
  `src/shared/constants/generation.constants.ts`;
- the gate rules are read live on every call; Node answers its last good read when the read fails,
  which falls back here.
