# App store listings read model: design

**Status:** slices 1 to 4 of 8 done, all dark. Slice 1 is the adapter side of `store-listing@v1`
(`src/server/registry-adapter/listing-stream.ts`). Slice 2 is the app-index-go ingest behind
`APP_INDEX_LISTINGS` (`internal/index/listings.go`, `internal/store/listing*.go`; README,
"Listings read model"). Slice 3 is the read API, `GET /listings` and `GET /listings/{slug}`
(`internal/listingread`, `internal/api/listings.go`; README, "Listing API"). Slice 4 is the site's
shadow of the store grid and the public REST list behind the `app-listings-read-model` Flipt flag
(`src/server/services/blocks/app-listings-read-model-shadow.service.ts`; Shadow diff, below). The
site still serves every listing read from the database; serving from the read model is slice 5,
after the gate below.

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

| Gate                                                                                     | Today                                             | In the read model                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mature ratings (`r`, `x`, `xxx`; XXX only with XXX in the level)                         | `matureRatingsAllowed(redCapable, browsingLevel)` | The same rule over the same two inputs, which the web tier resolves as it does for its database read and sends signed (README, "Listing API": `host`, `level`). A host that is not red-capable admits no mature rating whatever the level |
| Region hold                                                                              | the SFW domain for restricted regions             | Already in the web tier's inputs: a held region is served the SFW domain, which the web tier sends as `host: main`                                                                                                                        |
| Store scope (`none` / `public-external` / `full`, the Flipt cohorts and the kill switch) | `resolveStoreVisibilityScope`                     | Passed in by the web tier, which already resolves it. The read model applies `none` as empty and `public-external` as off-site only. Flipt stays the one judge of the cohort                                                              |
| Audience floor (testers, moderators)                                                     | `listingLevelVisibilityFilter`                    | Not in the read model: a floor other than `public` goes to the DB (above)                                                                                                                                                                 |
| Media above the viewer's level                                                           | per image, `listingMediaCeiling`                  | Per item, from its `nsfwLevel`, with the same ceiling and the same red-override preference (Media, above; `listingread.ProjectMedia`)                                                                                                     |
| Banned or deleted owner                                                                  | `storeOwnerEligibleWhere`                         | Upstream: the listing leaves the catalog read, so the stream deletes it                                                                                                                                                                   |

**Who resolves the viewer.** Decided in slice 3: the web tier, not this service. An earlier draft had
the read model ask the content-policy service about the viewer's forwarded token. That would make a
second service a judge of what the web tier already decides on every request (host, browsing level,
store scope, from the same session and Flipt reads), and a shadow diff between two deciders would
measure their disagreement as well as the read model's. Instead the web tier sends what it resolved,
signed with a key the two share and valid for minutes, so the read model applies exactly the
inputs the database read applies. Nothing on the token identifies the viewer.

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

- **Paging:** keyset on `(sortKey, slug)`, with an opaque cursor, as today on `(sortKey, id)`.
  `top-rated` pins the mean in the cursor for the whole session, as `decodeListingCursor` does. The
  limit is 1–50, default 20. The read model's cursors carry their own version (`rm1`), so a
  database cursor sent to it, or one of its own sent to the database, pages from the start.
- **Filters:** `kind`, `category` and `userId` (developer filter). Text search stays the site's: it
  asks the app index (`/search`, under its `viewerNotRoutable` rule) for slugs, and hydrates them
  from the read model (`slugs`) instead of from the database.
- **Known divergences,** each measured by the shadow diff rather than assumed small:

  - `getGlobalRecommendMean` averages over every approved listing, restricted ones included. The
    read model sees public listings only. If the order moves materially, the adapter can publish the
    mean as a single `service@v1` parameter.
  - Ties fall to the slug, where the database uses the listing id: the stream carries no id yet.
    Most of the store ties on `top-rated` (no reviews), so this reorders ties until the id is in the
    stream (Rollout, slice 3b).
  - The keys compare as bytes; the database compares `sort_key` under its collation. Only the `name`
    sort can differ (punctuation, case-folded non-ASCII).

- **Sub-listing cards** (`app-store-sub-listings`) are not in the stream. A grid request that asks
  for them merges them from the DB page, as index search already does.

## Shadow diff

Slice 4 shadows the store grid (`appListings.listAvailable`, every page) and the public REST list
(`GET /api/v1/apps`). Detail, card and OG are slice 5. With the `app-listings-read-model` Flipt
flag on, the site serves the database answer exactly as before, and afterwards, off the response
path, asks the read model the same query and compares the two
(`app-listings-read-model-shadow.service.ts`).

- **The viewer.** The token is signed from the options object the database read was given
  (`app-index-viewer-token.ts`): `host` from `redCapable`, `level` from `viewerBrowsingLevel`
  (absent is 0), `scope` narrowed by `narrowStoreScope`, the same defaults the database read applies.
  A floor other than `public`, or a level that is not an integer from 0 to 63, is not shadowed.
  `viewer_test.go`'s literal vector pins the signer on both sides.
- **Not shadowed:** a page with sub-listing cards on it, a page the app index's search answered,
  and page 2 onward when the listing the database cursor sits after no longer exists (its slug, the
  read model's tie-break, cannot be named).
- **Paging.** A database cursor `(sort_key, id, mean)` is sent as the read model's cursor
  `(sort_key, slug of id, mean)`: one primary-key read of the slug, so both sides rank page 2 onward
  with the same pinned mean. A cursor-format literal is pinned on both sides (`rank_test.go`
  `TestCursorVector`, the shadow's test).
- **Compared by slug** (the stream carries no listing id until slice 3b):
  - a slug on one page only is asked of the other side by slug, with the same kind and category
    (`?slugs=` on the read model; `listStoreListingsBySlugs` on the database, plus the developer
    filter). Not shown to this viewer at all there: a **visibility** mismatch,
    `visibility_missing` (the read model hides a listing the database shows) or `visibility_extra`
    (the read model shows a listing the database does not; the dangerous one). Shown there: the two
    sides only page or order it differently, which is an order mismatch;
  - a slug on both pages: its gated media (`iconUrl`, `coverUrl`) is a **media** mismatch when it
    differs; an **identity field** (`name`, `tagline`, `category`, `contentRating`, `creator`,
    `isBeta`, `isOfficial`, `kindData` less `appBlockId`) an `identity_field` mismatch; and a
    **stats field** (`recommendedCount`, `notRecommendedCount`, `recommendPct`, `reviewCount`,
    `openCount`, `updatedAt`) a `stats_field` mismatch. Identity fields say what the listing is, and
    a difference there is a read-model bug; stats fields can trail the database by up to an adapter
    poll (Stats freshness). The classes are `READ_MODEL_FIELD_CLASS`, pinned field by field by the
    shadow's test;
  - **order**, reported apart: the slugs left once visibility mismatches are removed differ in
    order, or one side has a next page and the other does not. Ties fall to the id on the database
    and to the slug on the read model, so order mismatches are expected on `top-rated` (most of the
    store ties there) until slice 3b; they never count as visibility.
- **Bounded:** a sampled fraction of pages (`APP_LISTINGS_READ_MODEL_SHADOW_SAMPLE`, default 0.1),
  at most `APP_LISTINGS_READ_MODEL_SHADOW_MAX_IN_FLIGHT` per process at a time (default 4; more are
  dropped, never queued), each read-model call and each of the shadow's own database reads waited
  on for at most `APP_LISTINGS_READ_MODEL_SHADOW_TIMEOUT_MS` (default 1000; a database read past it
  is not cancelled, only no longer waited on), and a per-process breaker (`IndexBreaker`, with the `APP_INDEX_BREAKER_*` knobs):
  after consecutive read-model failures the shadow stops for a cooldown. The breaker is asked only
  immediately before the first read-model call, so a page that returns earlier never spends its
  half-open probe. The extra database reads
  are the cursor's slug (page 2 onward) and the by-slug check, only for a page that differs.
- **Metrics** (`src/server/prom/app-listings-read-model.metrics.ts`), each by `surface` (`grid`,
  `rest_list`):
  - `app_listings_read_model_shadow_requests_total{surface, outcome}`: `compared`, or why not:
    `unconfigured`, `unsupported_viewer`, `unsupported_input`, `breaker_open`, `saturated`,
    `timeout`, `not_ready`, `error`, `bad_response`, `db_error`, `db_timeout`;
  - `app_listings_read_model_compared_pages_total{surface}` and
    `app_listings_read_model_compared_slugs_total{surface}` (listings on either page: the
    denominator);
  - `app_listings_read_model_mismatches_total{surface, kind}`, `kind` one of `visibility_missing`,
    `visibility_extra`, `media`, `identity_field`, `stats_field`, one per listing per kind;
  - `app_listings_read_model_field_mismatches_total{surface, field}`;
  - `app_listings_read_model_order_mismatches_total{surface}`, one per page;
  - `app_listings_read_model_breaker_state` and `app_listings_read_model_breaker_transitions_total{to}`.
- **Logs:** one line per page that differs, at most 30 a minute per process: the surface, the
  slugs of each visibility mismatch, the field names that differ per slug, and whether the order
  differs. Never a card's values, a query, or anything about the viewer.

### Go / no-go for serving (slice 5)

Serve the grid or the REST list from the read model only when, for that surface, over 7
consecutive days of shadow traffic:

- `visibility_missing + visibility_extra + media + identity_field` mismatches are under 0.1% of
  compared slugs:
  `sum by (surface) (increase(app_listings_read_model_mismatches_total{kind=~"visibility_missing|visibility_extra|media|identity_field"}[7d])) / sum by (surface) (increase(app_listings_read_model_compared_slugs_total[7d])) < 0.001`;
- every `visibility_extra` that did occur is explained (the log names the slugs; a listing
  delisted within the adapter's poll is the expected one);
- the breaker never opened, and `compared` is the large majority of the outcomes.

Order and `stats_field` mismatches are reported, not gating: a stats field trails the database by
up to an adapter poll, and ties order differently until slice 3b. A listing whose stats differ
persistently (across more than two polls) is still read before serving.

### Turn-on order

Each step is reversible by undoing it; nothing before the flag changes what any user sees.

1. The adapter publishes `listingContentRating` (slice 3), so the read model holds every listing
   at layout 2.
2. `APP_INDEX_LISTINGS=on` on app-index-go, after the service identity and the listing relay gate
   it needs (Rollout, slice 2), and its first listings generation is serving.
3. The viewer key on both sides: the same secret of at least 32 bytes as `APP_INDEX_VIEWER_KEY` on
   app-index-go and on the site. `APP_INDEX_URL` is already set on the site for search.
4. The `app-listings-read-model` flag on, for shadow. The flag is created in the Flipt state
   repository (not in this repo); this code reads it as a global boolean, off when it is absent.

## Cutover flags

Slice 1 added the first, slice 2 the second and slice 4 the third.

| Flag                                            | Values           | What                                                                                                    |
| ----------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| `REGISTRY_ADAPTER_LISTING_RELAYS` (adapter env) | relay client ids | the listing stream exists, for those relays only. Empty means off (this PR)                             |
| `APP_INDEX_LISTINGS` (app-index-go env)         | on/off           | ingest `store-listing@v1` (slice 2), and serve the listing API (slice 3). Unset means off               |
| `app-listings-read-model` (Flipt)               | boolean          | slice 4: on = shadow the grid and REST list (Shadow diff). Serving (slices 5–6) will add its own switch |

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
   generations, cursor and consumer lock; own tables: `app_index_listings`, and, until slice 3,
   `app_index_listing_media` with one row per media item as sent), dark behind
   `APP_INDEX_LISTINGS`. Unset, nothing of it exists: no tables, no series, no
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
     applies `listingMediaCeiling` and `redHostMediaCeiling` per request (Media, above).
   - Slice 2 held the media twice, in the listing's jsonb body and in `app_index_listing_media`.
     Decided in slice 3: the body is the copy, and the table is dropped. The body is the entity as the
     stream sent it, kept whole anyway, so it cannot disagree with what was received; the read path
     decodes the body for the card fields that have no column (tagline, creator, flags, kind data)
     and gets the media in the same read, with no second query; each read decodes them with the
     ingest's own validator (`ListingFromEntity`), so one rule gates both; and an upsert writes one
     row instead of one per item. Nothing read the table, and every generation's bodies already hold
     its items, so dropping it changes no row: no `ListingsLayoutVersion` bump.
   - Also in slice 2: a test of the live `loadListingExtras` query (`catalog-source.live.test.ts`),
     and the NsfwLevel-to-rating ladder in one place.
3. **Slice 3 (done): read API.** `GET /listings` (the four sorts, keyset paging, the kind, category
   and developer filters, text search through the app index, full cards) and `GET /listings/{slug}`
   (detail), and `slugs` hydration for the site's own search (the read model runs no text search),
   with the viewer gates, behind `APP_INDEX_LISTINGS` and a signed viewer token (README,
   "Listing API"). The media rule is pinned on both sides by one fixture
   (`internal/listingread/testdata/media-parity.json`, read by `parity_test.go` and the site's
   `listing-media-parity.test.ts`); the shadow diff relies on it.
   - Also in slice 3: `listingContentRating`, the listing's own rating, added to `store-listing@v1`
     (additive, nullable). The body's `contentRating` is the app entity's, which falls back to the
     block's when the listing has none; the store gates and shows the listing column alone, so the
     read model gates on the new field (`ListingsLayoutVersion` 2: a new column, rebuilt beside; the
     API answers 503 from an older-layout generation until the switch). The ingest treats a body
     without it as unusable, so a read model never gates a listing on the wrong rating.
   - A second viewer key, `APP_INDEX_VIEWER_KEY_NEXT`, for rotation with no refused requests.
   - **Slice 3b (adapter, additive to `store-listing@v1`):** the listing `id` (the card key and the
     database's tie-break), then the detail fields (`serialId`, `collaborators`, `scopes`,
     `connectScopes`, the links, `betaMessage`, the fork fields). Until then the read API answers
     without them, and the shadow diff compares by slug.
4. **Slice 4 (done): shadow** on the grid and REST list: the web tier signs the viewer token, calls
   `GET /listings` after its database read behind `app-listings-read-model`, serves the database
   answer, and compares (Shadow diff, above).
   - Also in slice 4: `GET /listings` ranks from a per-process memo of the serving generation's
     keys, read once per (generation, cursor) and shared by concurrent requests, instead of a scan
     of every listing per request (README, "Listing API").
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
