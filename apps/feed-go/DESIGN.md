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
     (Postgres); Model3D link visibility;
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
| Hydration | every cache hit; Postgres miss paths for basic user data, cosmetics, profile pictures, thumbnails | misses on user cosmetics, image frames, event decorations, tag ids, metric hashes |
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
                     ordering, gallery gates
internal/feedsvc     the image feed service: query mapper, cursor codec, HTTP client
internal/hydrate     read-only cache readers (msgpack) and miss paths
internal/shadow      the comparator
internal/server      HTTP handlers, metrics
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
  hydration of nine lookups of which at most five can reach Postgres at once (basic users, cosmetics
  and profile pictures on a cache miss; video thumbnails; a signed-in viewer's reactions), then a
  3D-model read when the page has any. With lazy post images on, a comparison then runs one post-count
  query and up to `completionConcurrency` (4, `internal/feed/pager.go`) completion fetches at once,
  each a page query plus its hydration. So the worst case is ~4 × 4 × 5 = 80 concurrent reads, and the
  common case is far fewer (page queries plus the reads that always go to Postgres). 8 covers the
  common case with headroom and makes a burst wait instead of opening 80 pooler connections per pod.
  Page 1 of a gallery with pinned posts or a sponsored post adds one sequential fetch (plus its
  hydration) for each before the page loop, which does not raise that worst case.
- **Redis (cache cluster):** the same per-id caches, read-compatibly: plain msgpack maps
  (msgpackr's module-level `pack`, `useRecords: false`), Dates as the timestamp extension, `undefined`
  as fixext type 0, `notFound` / `debounce` markers honoured, stale entries served. **This service
  never writes those keys** — a Go encoding bug cannot poison a cache the Node app reads. The cost:
  a miss Go sees stays a miss until Node fills it; the fallback rate shows how often that matters.
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
  `GET <base>/v1/feed?<query>` with a 5s timeout, `x-request-source: shadow` and
  `x-replay-id: feed-go-shadow` (the feed service labels its metrics by the replay id, so shadow load
  stays out of its live series), at most four completion fetches at once per request, the query built
  exactly as `mapSearchInputToFeedQuery(input, 'primary', 'website')` builds it (`internal/feedsvc`,
  tests pin the literal query strings). A mapper refusal Node answers with an empty page is answered
  with an empty page here too; one Node answers with a 400 falls back. The feed's ids are hydrated
  with this service's own SQL (`ids` filter, no model join, `AllTime`, statement timeout as an error)
  and put back in the feed's order. Not ported: `hydrateWithReadRescue` (an empty hydrate
  is retried on another replica this service does not reach — it falls back instead), and the
  `feed-service-degrade` breaker and last-good page (every failed call falls back).
- **ClickHouse:** not yet. Metric counts come from the watcher-fed Redis hashes; a missing hash (Node
  would populate it from ClickHouse) is a fallback. Porting that read is listed in §9.

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
- each comparison gets one result: `match`, `fields` (same posts, same order, some field differs),
  `order` (same posts, different order), `membership` (different posts), `unsupported` (Go fell back,
  with its reason), `go_error`;
- each differing path is counted by **category** — the path with indices folded to `*`, truncated at
  opaque JSON (`metadata`, cosmetic `data`) so label cardinality is bounded by the schema:
  `feed_go_shadow_field_diffs_total{category="items.*.images.*.stats.likeCountAllTime",kind="value"}`;
- differing paths (never values) are logged for a sample, so a category can be traced to a field.

**Expected noise.** Go answers milliseconds after Node, so a reaction count, a metric hash refresh or
a newly published image can differ without a bug. These show up as `stats.*` value diffs and rare
`membership` diffs on page 1 of busy galleries. The comparator does not hide them; the acceptance
read separates them by category.

**Acceptance (operator's call, per category):** sustained `match` + explainable-noise categories
over a window that covers every supported shape in volume, zero `membership` / `order` diffs not
explained by timing, and a fallback rate low enough that serving is worth it.

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
| event decoration flags | which event hats are visible to which viewer | `FEED_GO_DECORATION_EVENTS`: the events visible to **every** viewer; tester-only previews are a parity gap |
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
- cache misses on user cosmetics, image frames, event decorations, tag ids (their lookups filter
  withheld creator cosmetics, read the primary, or join the tag cache — not ported), metric hashes
  (ClickHouse populate not ported), session users (auth hub fetch not ported), gallery settings
  (rebuild not ported);
- bearer tokens, two session cookies, verified crawlers, POST (`methodOverride`) requests;
- public requests from an origin the app's allow-list does not hold (reason `origin`, see §4).

**Matched behaviour worth knowing:** a page query that runs past the 20s statement timeout answers an
empty page, as Node does, rather than falling back (which would run the same slow query a second time
on Node).

**Divergences the comparator will show:**
- `referentialEqualities` and opaque-object key order (not visible after decode; excluded by design);
- per-viewer event-decoration visibility (testers before an event launches);
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
shadow samples, so its CPU per call is a plain ratio. **That ratio is an UPPER BOUND for serving:**
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
  shadow sample holding a queue slot when it started, and no sample was admitted before it ended.
- `feed_go_shadow_phase_solo_total` — how many phases were counted in the CPU series (its denominator).

**Method, and why.** Go has no faithful per-request CPU clock: a request's work runs on several
goroutines (the hydration lookups run in parallel) that migrate across OS threads, so a thread CPU
clock misses work and a goroutine cannot be pinned without changing the program. Process CPU deltas
are exact when only one request is running, and the shadow pod is in that regime almost all the time
(it serves nothing but sampled shadow requests, at a low rate). So the CPU series counts only phases
no other sample overlapped, and `solo_total` says how many that was. Wall time is NOT a CPU proxy for
`compute`: it is mostly waiting on Redis, Postgres and the feed service, so apportioning process CPU by
wall-time share overstates compute; use the wall histogram for latency and as a sanity check only.

```promql
# Go CPU per SERVED call, compute only (the go/no-go figure).
sum(rate(feed_go_shadow_phase_cpu_seconds_total{phase="compute",outcome="served"}[1h]))
  / sum(rate(feed_go_shadow_phase_solo_total{phase="compute",outcome="served"}[1h]))

# Coverage: share of served computes that were solo (low share = the per-phase figure is a sample).
sum(rate(feed_go_shadow_phase_solo_total{phase="compute",outcome="served"}[1h]))
  / sum(rate(feed_go_shadow_phase_seconds_count{phase="compute",outcome="served"}[1h]))

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
  to trigger it), or after the sample. `compute` can therefore read slightly LOW against serving, where
  that GC is paid between requests. Bound it with the unaccounted-CPU cross-check, and with the Go GC
  series (`go_gc_*`) from the runtime collector; under real serving load the GC share is better read
  from a profile (below) than from these series.
- *Solo only.* Overlapping samples are excluded, not apportioned; if coverage is low (raised sample
  rate, a burst), the figure is a sample of the quiet periods, which can differ from loaded behaviour
  (less cache contention, no scheduler pressure).
- *Not covered:* building the synthetic request, the goroutine hand-off, and on the serving path the
  response write (`trpc.WriteResult`) and the reverse-proxy cost of a fallback. All are small next to
  `compute`; a fallback's proxy cost is Node's request, read on Node's side.
- A Prometheus scrape that lands inside a phase is charged to it (one scrape per interval, small).
- Off unix there is no process CPU clock: only the wall histogram is recorded.

### 10.2 CPU profile

With `FEED_GO_PPROF=true` the internal listener (the `FEED_GO_INTERNAL_ADDR` port, never the public
one) serves `net/http/pprof` under `/debug/pprof/`. Off by default; turning it on is an env change
and a restart. Pull a profile through a port-forward to the pod's internal port:

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
  query (input shape, bearer token, origin) is cheap, but one raised during hydration (a cosmetics,
  metrics, tag-id, frame, event-decoration, session or gallery miss) comes after the page query and
  the parallel lookups, and in the post loop after earlier pages. That CPU lands in the numerator with
  no served request in the denominator, so it is a second reason Go's figure is an upper bound; read
  the fallback-reason rate beside it;
- run both reads over the same windows and compare medians across several windows, not one;
- note what Go does **not** pay yet: cache write-back, ClickHouse populates, auth-hub fetches — all
  rare misses that Node pays and Go falls back on. The fallback rate bounds how much this can matter;
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
  service) once serving.
- **Network:** Node pods → feed-go `:9090` (shadow); feed-go → replica, both Redis (and the system
  Redis Sentinels), the JWKS endpoint, the image feed service,
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
3. **Cut fallbacks that matter by volume** — the metric-hash ClickHouse populate and the cache miss
   paths, in fallback-rate order (pinned and sponsored posts were ported on 2026-11-14). Each is a
   contained port; together roughly one to two weeks.
4. **Flags** — a Flipt evaluation client so the env mirrors go away (a few days).
5. **Serving** — the client transport flag PR, a small cohort, then ramp while watching error rate,
   latency and the Node-side CPU drop. A week of ramp.

So roughly three to five weeks of focused work from merge to serving a meaningful share — most of it
in step 2, which only production traffic can size. The CPU-per-call answer itself arrives earlier:
step 1 plus a few days of shadow traffic.
