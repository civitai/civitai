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
`getAllImages` (`src/server/services/image.service.ts`). With the image-index feed flag off, which is
the production state, every page is the Postgres path:

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
4. **Posts.** Creators' reviews of the model, per-post fields, a per-sort ordering, wire trims.
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
| Input | model / version / Model3D / global feed; sorts Most Reactions, Most Comments, Most Collected, Newest, Oldest; period filters; `types`, `generation`, `withMeta`, `fromPlatform`, `disablePoi`, `disableMinor`, `hideChallenges`, `excludedTagIds`, `excludedUserIds`; numeric cursors | `hidden`, user / username / collection / post / tags / tools / techniques / reactions / followed / baseModels / pending / scheduled / jumpTo / hub inputs, `include` beyond the default, Random / Recently Added sorts, compound or date cursors |
| Viewer | signed out; `civ-token` cookie sessions | API keys / OAuth bearer tokens, two session cookies at once, a session user not in the shared cache, verified crawlers |
| Gallery gates | settings from cache, held level, taken-down models | a settings key Node would rebuild; pinned posts on page 1; sponsored posts while creator promotions are on |
| Hydration | every cache hit; Postgres miss paths for basic user data, cosmetics, profile pictures, thumbnails | misses on user cosmetics, image frames, event decorations, tag ids, metric hashes |
| Flags | see §8 | lazy per-post images on |

Layout:

```
cmd/feed-go          wiring, listeners, fallback proxy
internal/trpc        tRPC v11 query/response envelopes
internal/superjson   the superjson writer the client decodes
internal/auth        session JWS verification, revocation registry, cached session user
internal/browsing    level flags, domain cap, browsing-settings addons, host color, region rules
internal/feed        input parsing, the SQL, page loop, post grouping and ordering, gallery gates
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
  `createContext`.
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
| `image-index-feed` | search-index path instead of Postgres | only the Postgres path is ported; the index path must stay off for the routed cohort |
| `gallery-lazy-post-images` | first 6 images per post + `imageCount`, extra completion fetches | `FEED_GO_LAZY_POST_IMAGES`; on → fall back |
| `creator-promotions` | sponsored post on page 1 | `FEED_GO_CREATOR_PROMOTIONS`; on → page-1 model galleries fall back |
| `image-resource-use-write` | model-gallery queries read the primary | not mirrored: off in production; the replica is used |
| `image-feed-shared-users` | one `user` object per creator on the wire | decoded value unchanged; nothing to do |
| event decoration flags | which event hats are visible to which viewer | `FEED_GO_DECORATION_EVENTS`: the events visible to **every** viewer; tester-only previews are a parity gap |
| `kysely-image-reactions`, `image-metrics-swr`, cache L1 switches | same results by another route | nothing to do |

## 9. Not at parity (yet)

Each item is either a fallback (correct, just not served here) or a known divergence the comparator
will show.

**Fallbacks (correct, not served):**
- every input shape in the right-hand column of the §2 table;
- pinned posts (page 1 of a gallery with pins) and sponsored posts;
- lazy per-post images (`gallery-lazy-post-images` on);
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

## 10. Measurement plan — CPU per call, Go vs Node, same traffic

Shadow mode gives both sides the same requests. During it the Go process does nothing but handle
shadow samples, so its CPU per call is a plain ratio. **That ratio is an UPPER BOUND for serving:**
each shadow sample also costs work serving never does — receiving and decoding Node's envelope (up
to 32 MiB) and `shadow.Compare` parsing both answers and walking the two trees. That comparison
overhead is included in `process_cpu_seconds_total` and is not separated out, so a measured Go
figure below Node's is conservative, and a figure near Node's does not by itself show Go is no
cheaper.

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
  rate is raised (shadowing doubles the read work for sampled requests).

The decision input is the ratio of the two CPU-per-call figures, on the same requests, at parity,
with Go's side read as an upper bound (it includes the shadow decode and compare, above).

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
  `FEED_GO_FALLBACK_URL` (the in-cluster Node service) once serving.
- **Network:** Node pods → feed-go `:9090` (shadow); feed-go → replica, both Redis (and the system
  Redis Sentinels), the JWKS endpoint,
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
3. **Cut fallbacks that matter by volume** — likely pinned posts (page 1 of popular galleries), the
   metric-hash ClickHouse populate, and the cache miss paths, in fallback-rate order. Each is a
   contained port; together roughly one to two weeks.
4. **Flags** — a Flipt evaluation client so the env mirrors go away (a few days).
5. **Serving** — the client transport flag PR, a small cohort, then ramp while watching error rate,
   latency and the Node-side CPU drop. A week of ramp.

So roughly three to five weeks of focused work from merge to serving a meaningful share — most of it
in step 2, which only production traffic can size. The CPU-per-call answer itself arrives earlier:
step 1 plus a few days of shadow traffic.
