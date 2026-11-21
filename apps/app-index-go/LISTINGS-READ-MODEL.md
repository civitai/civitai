# App store listings read model: design

**Status:** slices 1 and 2 of 8 done, both dark. Slice 1 is the adapter side of `store-listing@v1`
(`src/server/registry-adapter/listing-stream.ts`). Slice 2 is the app-index-go ingest behind
`APP_INDEX_LISTINGS` (`internal/index/listings.go`, `internal/store/listing*.go`; README,
"Listings read model"). Nothing serves from it yet: the read API, shadow diff and cutover are later
slices, listed under Rollout.

The goal: the user-facing app store reads its listings from a read model built from the registry,
instead of from Prisma reads in `app-listing.service.ts`. The surfaces covered are the store grid
and search, the detail page, the card, the OG image, launch (`/apps/run/[slug]` and its install
config), and the public REST `GET /api/v1/apps` and `GET /api/v1/apps/{slug}`. Owner, creator and
moderator screens stay on the database (see What stays on the database).

```
app_listings (DB) → registry adapter → registry-exp → app-index-go (read model) → civitai.com tRPC / REST
```

## Today

- Every listing read is a `dbRead` read in `app-listing.service.ts`: `listAvailableListings` (grid,
  REST list), `listStoreListingsBySlugs`, `getListingDetail` (detail, REST detail),
  `getListingCard`, and `getListingSocialImage` (OG).
- The store grid goes through `listStoreGrid` (`app-index-search.service.ts`). With
  `app-index-search` on, a text query is sent to app-index-go `/search`. The index returns slugs in
  ranked order, and the cards are read again from the database. Page 2 and later, the developer
  filter, mature viewers and tester or moderator floors all go to the database.
- app-index-go follows `app@v1` anonymously, so it holds SFW apps only. It sorts by relevance or
  name, has no paging, and holds no stats.
- `app@v1` carries identity, rating, tagline, category, icon, creator username, runtime, external
  link, current release and fork parent. It has no stats, no cover or screenshots, no description,
  no creator id or avatar, and no beta or official flags.

## Schema: a new `store-listing@v1`, not a wider `app@v1`

`urn:schema:apps.civitai.com:store-listing@v1`. One entity per app entity, URN
`urn:apps.civitai.com:store-listing/{slug}`, whose `app` names the app entity. The name is
`store-listing`, not `listing`, because `urn:schema:schemas.civitai.com:listing@v1` is already
published, and a schema name can't be changed once it is promoted.

`app@v1` could take these fields as new optional properties, and stay within `@v1`. It doesn't,
for two reasons:

1. **Promotion order.** `app@v1` is already on both registries. Every field added to it is
   published to the official registry the day it ships. New schemas ship on `registry-exp` first,
   and are promoted once proven. A new schema can be gated to one registry (below); a field of an existing
   schema cannot.
2. **Churn.** Stats change every rollup run. If they were in `app@v1`, every consumer of the app
   entity would get an upsert for each app every few minutes, though nearly all of them want only
   its identity. A separate stream keeps `app@v1` quiet.

**Who receives it.** The relay gate (`REGISTRY_ADAPTER_LISTING_RELAYS`) is a rollout gate, not an
audience boundary. The stream is published to every subscriber of a listed relay, whichever user
that relay exchanged a token for, so every field it carries must be public. They are: each is on the
public store card or detail page, or in `GET /api/v1/apps`.

### Fields in slice 1

| Field                                                                                              | Source (same catalog read as `app@v1`)                                                                                                                          |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`, `slug`, `name`, `kind`, `contentRating`, `tagline`, `category`, `iconUrl`                   | the same values the app entity publishes (`appContentRating`, `registryIconUrl`)                                                                                |
| `description`                                                                                      | `app_listings.description`                                                                                                                                      |
| `media[{slot, host, url, nsfwLevel, rating, caption?, coverUrl?}]`                                 | every image the store may show, each rated on its own, including the civitai.red overrides (`host: red`). See Media below                                       |
| `creator{id, username, image}`                                                                     | the card's creator chip                                                                                                                                         |
| `isBeta`, `isOfficial`                                                                             | the card                                                                                                                                                        |
| `hasPage`, `liveUrl` (on-site), `externalUrl` (off-site)                                           | the card's kind data                                                                                                                                            |
| `stats{recommendedCount, notRecommendedCount, recommendPct, reviewCount, openCount, installCount}` | the card's rollup, plus `install_count`. `openCount` is null off-site, as on the card                                                                           |
| `createdAt`, `updatedAt`                                                                           | `app_listings`. `createdAt` is kept because it is the `newest` sort key (`al.created_at`), which no other field gives; `updatedAt` is the card's "Updated" line |

Later, as new optional properties of `@v1` (additive, per `schemas.ts`): `serialId`,
`collaborators`, `scopes`, `connectScopes`, `issueTrackerUrl`, `actionsRunSource`, `betaMessage`,
`forkable`, and `forkOf{slug,name}`. Each costs another read per catalog. The card and the sort keys
don't need them; the detail page does (slice 3).

Never in the stream: `connectClientId` (the card deliberately omits it), `visibility`, and
`restrictedAudience` (viewer-scoped). Listing media items are filtered per subscription by each
item's own rating under the app-rating rule (Media, below), which is coarser than the store's
per-request ceiling. The creator chip's `image` is the user's avatar, carried as the public card
carries it.

### Media

Decision: carry the red overrides. The stream carries every image the store could show on any
host to any viewer, each as its own item with its own `nsfwLevel` and `rating`. The read model then
picks per host and viewer. In order, the items are:

1. the listing's own icon;
2. its own cover;
3. its screenshots, in stored order;
4. the civitai.red icon override;
5. the civitai.red cover override.

The adapter (`registryListingMedia`, `catalog-media.ts`):

- Publishes an image only when it passes the store's per-image moderation check at every level
  (`isListingImageVisible`). That means scanned, not flagged, not restricted, and not Blocked.
- Filters each subscription's items by the item's own rating under the app-rating rule
  (`audienceAdmits` in `readableBy`, the predicate listings use): `pg` and `pg13` items reach every
  audience, and `r`, `x` and `xxx` items only an audience that may read that rating. The body, and
  its `rev`, differ per audience.
- This filter is coarser than the store. A PG-13 image on a `pg` listing reaches a PG-only
  audience in the stream, where the store caps it at the listing's rating. That is deliberate: it
  is what lets a red-host PG-13 viewer get it, and every stream field is public. So the read model
  **must** apply the store's rule per request: the listing-rating ceiling (`listingMediaCeiling`)
  and the host rule (`redHostMediaCeiling`), below.
- Marks an override `host: red`, so the main host never shows it.
- Gives a screenshot item a `coverUrl` as well: its rendition at cover width, for the cover fallback.

What today's DB path does, which the read model must mirror (`projectListingMedia`,
`listingMediaCeiling` and `redHostMediaCeiling` in
`src/server/services/blocks/listing-media-audience.ts`):

- **Ceiling.** Off a red-capable host, the ceiling is the SFW levels intersected with the levels up
  to the listing's rating. On a red-capable host, it is that same ceiling united with the viewer's
  browsing levels, Blocked excluded. So on a red host, an X viewer sees an X screenshot on an R
  listing.
- **Overrides.** The overrides are read only for a red-capable request (`listAvailableListings`,
  `getListingDetail` and `getListingCard` call `readListingRedMediaManyForRender`, in
  `listing-media-split.service.ts`). Each override is gated by the same ceiling, and is preferred
  over the own image of its slot.
- **Icon fallback.** The icon is the red icon if visible, else the own icon if visible.
- **Cover fallback.** The cover is the red cover, else the own cover, else the first visible
  screenshot at cover width (`gatedListingCoverUrl`).
- **Screenshots.** The gallery is the visible screenshots, in order (`gatedListingScreenshots`).

If the overrides read fails, `readListingRedMediaManyForRender` logs a warning and returns an empty
map, and the store shows each listing's own media. The stream does the same: the override items
silently drop out of the bodies until the next good read. Only a failure of the listings' own media
query ends listing subscriptions `unavailable`.

## Visibility: testers-only and private listings stay out of the stream

The stream is built from the public catalog read. That is `listAvailableListings` with
`floor: 'public'` and the anonymous catalog scope, the same read `app@v1` uses. Listings at
`private`, `moderators` or `testers` visibility are excluded in SQL (`listingLevelVisibilityFilter`)
and never reach the adapter. A test pins that the listing entities are exactly the app entities
(`listing-stream.test.ts`, "seam"). So `store-listing@v1` cannot carry a listing that `app@v1`, which is
already live, does not.

**Decision: excluded, read from the database.** A viewer whose floor is not `public` (testers,
moderators) stays on the database for every listing read, as index search does today
(`viewerNotRoutable` → `unsupported_viewer`). The alternative was a gated stream that the read model
filters per cohort. That would send restricted listings to a second service and a second database,
and the read model would become a judge of cohort membership. The DB path for those viewers is unchanged, so excluding them costs nothing.
Revisit only if the DB path for that cohort becomes the bottleneck.

The store owner's own unapproved and private listings are owner screens, and stay on the database.

## Stats freshness

Stats (`thumbs_up_count`, `thumbs_down_count`, `open_count`, `install_count`) come from the
`app-listings` metrics rollup, which runs every 5 minutes (`update-metrics.ts`). The adapter re-reads
the catalog every poll (60 s by default, `REGISTRY_ADAPTER_POLL_SECONDS`), shared across
subscriptions. A stats change is a normal upsert of that listing.

**Decision: stats travel in the stream, not as a separate periodic snapshot.** They can change no
faster than the rollup, at most once per listing per 5 minutes, so the stream carries at most one
upsert per listing per rollup run. A separate
`listing-stats@v1` stream, or a snapshot the read model pulls, would add a second consistency
boundary for no saving at the catalog's current size. Split it out only if upsert volume becomes a measured problem,
around 10k listings or a rollup cadence under a minute. The stats are aggregates over all users and
are already public on the card and in REST.

End-to-end staleness: the rollup's lag applies to the DB card as well, since both read the same
`app_listing_metrics` row. So the read model trails the DB card by one adapter poll plus its own
ingest, about a minute at the defaults. The shadow tolerance below allows for that.

## Viewer gates in the read model

The read model ingests every rating. Its subscription uses the index's service identity
(`REGISTRY_ADAPTER_SERVICE_CLIENTS`; README, "Subscribing as itself"), so the adapter streams it the service audience,
`r`, `x` and `xxx` included. Per request, the read model then applies:

| Gate                                                                                     | Today                                             | In the read model                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mature ratings (`r`, `x`, `xxx`; XXX only with XXX in the level)                         | `matureRatingsAllowed(redCapable, browsingLevel)` | Decided from the viewer's token by the content-policy service, the same decision the adapter enforces for signed-in streams. The web tier forwards the viewer's token; anonymous is SFW. A host that is not red-capable is SFW whatever the token says, so the web tier also sends `redCapable` |
| Region hold                                                                              | the SFW domain for restricted regions             | content-policy's `regionHold`: no mature rating                                                                                                                                                                                                                                                 |
| Store scope (`none` / `public-external` / `full`, the Flipt cohorts and the kill switch) | `resolveStoreVisibilityScope`                     | Passed in by the web tier, which already resolves it. The read model applies `none` as empty and `public-external` as off-site only. Flipt stays the one judge of the cohort                                                                                                                    |
| Audience floor (testers, moderators)                                                     | `listingLevelVisibilityFilter`                    | Not in the read model: a floor other than `public` goes to the DB (above)                                                                                                                                                                                                                       |
| Media above the viewer's level                                                           | per image, `listingMediaCeiling`                  | Per item, from its `nsfwLevel`, with the same ceiling and the same red-override preference (Media, above)                                                                                                                                                                                       |
| Banned or deleted owner                                                                  | `storeOwnerEligibleWhere`                         | Upstream: the listing leaves the catalog read, so the stream deletes it                                                                                                                                                                                                                         |

**Red host.** Decided: the read model carries the red overrides and the above-rating media (Media,
above), so a red-host viewer sees what the database shows them. No media difference is tolerated in
the shadow diff.

## Sort and paging

These match `listAvailableListings`.

| Sort               | Key (descending unless noted)                                                             | Read model                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `top-rated`        | Bayesian score `(PRIOR·mean + up) / (PRIOR + up + down)`, then the `popular` key, then id | the same formula over `stats`. The global mean is computed over the listings the read model holds |
| `popular`          | plays (`openCount`) on-site, installs off-site; then `installCount`; then id              | from `stats`                                                                                      |
| `newest`           | `createdAt`, then id                                                                      | `createdAt`                                                                                       |
| `name` (ascending) | `left(lower(name), 64)`, then id                                                          | the same                                                                                          |

- **Paging:** keyset on `(sortKey, id)`, with an opaque cursor, as today. `top-rated` pins the mean in
  the cursor for the whole session, as `decodeListingCursor` does. The limit is 1–50, default 20.
- **Filters:** `kind`, `category`, `q` (the existing word-prefix match), and `userId` (developer
  filter). Search results are ranked by relevance; with no `q`, by the requested sort.
- **Known divergence:** `getGlobalRecommendMean` averages over every approved listing, restricted
  ones included. The read model sees public listings only. The shadow diff measures how much the
  order moves. If it's material, the adapter can publish the mean as a single `service@v1` parameter.
- **Sub-listing cards** (`app-store-sub-listings`) are not in the stream. A grid request that asks
  for them merges them from the DB page, as index search already does.

## Shadow diff

This follows the `app-index-search` pattern. Behind a new Flipt flag, `app-listings-read-model`
(mode `shadow`), the tRPC grid, detail and card reads, and the REST handlers, call the read model
alongside the DB read. They serve the DB answer and compare the two.

- **Compared, per surface:**
  - grid: the ordered list of `id`s on the page, plus `nextCursor` presence;
  - every card: `name`, `tagline`, `category`, `contentRating`, `iconUrl`, `coverUrl`, `creator`,
    `isBeta`, `isOfficial`, `kindData`, `updatedAt`, `recommend`, `reviewCount`, `openCount`;
  - detail: the same, plus `description`, `screenshots` and `installCount`. The media fields are
    compared as the read model renders them for that request's host and viewer.
- **Tolerance:**
  - order and identity fields must match exactly;
  - stats may differ for up to two adapter poll intervals after the DB value last changed. These are
    counted as `stale`, not `diff`;
  - a listing that is missing on one side is a `membership` diff, never tolerated.
- **Metrics** (web tier, beside `app_index_search_*`):
  - `app_listings_read_model_requests_total{surface, source, reason}`, with `surface` one of grid,
    detail, card, og, rest_list or rest_detail, and `source` one of db or read_model;
  - `app_listings_read_model_diffs_total{surface, kind}`, with `kind` one of order, membership,
    field or stale;
  - `app_listings_read_model_field_diffs_total{field}`;
  - one log line per diff, with listing ids only and no viewer id.
- **Gate to serve:** 7 days of shadow at under 0.1% `order + membership + field` diffs per surface,
  and the breaker never open. This matches the private-data plan.

## Cutover flags

Slice 1 added the first and slice 2 the second. The third name is a proposal.

| Flag                                            | Values                            | What                                                                                                    |
| ----------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `REGISTRY_ADAPTER_LISTING_RELAYS` (adapter env) | relay client ids                  | the listing stream exists, for those relays only. Empty means off (this PR)                             |
| `APP_INDEX_LISTINGS` (app-index-go env)         | on/off                            | ingest `store-listing@v1` (slice 2), and serve the listing API (slice 3). Unset means off               |
| `app-listings-read-model` (Flipt)               | off / shadow / serve, per surface | the web tier's read path (slices 4–6), with the existing per-process breaker. Any failure serves the DB |

Rollback at each step is the previous flag value. The DB read path is never removed during this
work.

## Launch and install through `app-release@v1`

`/apps/run/[slug]` resolves the block through `BlockRegistry.resolvePageBlockBySlug` and serves its
manifest. `app-release@v1` already carries `manifest`, `manifestHash`, `bundleSha256`, `source` and
`collections` for every approved release, and the app entity's `release` names the current one. A
later slice can ingest `app-release@v1` into the read model as well, and resolve a launch as
follows:

1. Find the listing by slug and check the viewer gates above.
2. Take the app's `release`.
3. Serve that release's manifest and bundle hash.

The deploy gate (`current_version_deployed_at`) is already applied upstream: a listing whose block
never deployed is not in the catalog. Install config (scopes, connect scopes) comes from the release
manifest and the future `scopes` / `connectScopes` listing fields. The runtime's own checks (CSP,
the bundle origin) stay where they are. This is the last surface to move, after grid and detail have
served for a week.

## Rollout

1. **Slice 1 (done):** `store-listing@v1` in the adapter, dark. Unset, nothing changes, and no
   extra query runs. Set, there are two extra catalog queries per poll (`loadListingExtras`: the
   listings' media and the red overrides), run beside the existing ones. The stream reaches only the
   listed relays. If the media query (`findMany`) fails, only the listing stream fails: the failure
   is logged, its subscriptions end `unavailable`, and every other stream is served as before. If
   the overrides read fails, it returns no overrides, so they silently drop out of the bodies until
   the next good read (Media, above).
2. **Slice 2 (done): app-index-go ingest.** A second consumer for `store-listing@v1` (own
   generations, cursor and consumer lock; own tables: `app_index_listings`, and
   `app_index_listing_media` with one row per media item as sent), dark behind
   `APP_INDEX_LISTINGS`. No read API yet. Unset, nothing of it exists: no tables, no series, no
   subscription. Switching it on needs the
   service-identity rollout (README, "Rollout order": hub settings, then
   `REGISTRY_ADAPTER_SERVICE_CLIENTS`, then the index client), then
   `REGISTRY_ADAPTER_LISTING_RELAYS` set to `registry-exp`'s relay client id. The gateways route by
   namespace, so the new schema needs no routing of its own.
   - A snapshot with zero listings is suspect: the ingest holds the serving generation, logs and
     counts it (`app_index_listings_empty_snapshots_total`), and takes the snapshot again after the
     longest backoff, rather than switch to it. A catalog read that legitimately empties is rare. A
     failed listing read is already kept out of the stream: the adapter ends listing subscriptions
     `unavailable` and never serves the failure as an empty set (`CatalogRead.listingsFailed`), and
     the ingest resumes from its cursor after `unavailable`, deleting nothing.
   - Media are stored unfiltered, each item with its own rating and host. The read API (slice 3)
     must apply `listingMediaCeiling` and `redHostMediaCeiling` per request (Media, above).
   - Also in slice 2: a test of the live `loadListingExtras` query (`catalog-source.live.test.ts`),
     and the NsfwLevel-to-rating ladder in one place.
3. **Slice 3: read API.** `GET /listings` (sort, paging, filters, stats, full cards) and
   `GET /listings/{slug}` (detail), with the viewer gates. It also adds the detail fields to
   `store-listing@v1` (additive).
4. **Slice 4: shadow** on the grid and REST list.
5. **Slice 5: shadow on detail, card and OG,** then serve grid and REST after the gate.
6. **Slice 6: serve detail, card and OG.**
7. **Slice 7: launch and install** via `app-release@v1`.
8. **Promotion** to the official registry: drop the relay gate, once the registry owner agrees.

## What stays on the database

- Owner and creator screens: My apps, builds, drafts, submit and edit, revisions, analytics.
- Moderator screens: the review queue, moderation listing, takedowns, history.
- Tester and moderator store views (`floor !== 'public'`).
- Sub-listing cards.
- Writes of any kind, and every read inside a write transaction.
- The "restricted audience" badge, which is viewer-scoped and only shown to non-public floors.
- Fork lists and fork sessions.
- The developer track record (`getDeveloperTrackRecord`).
