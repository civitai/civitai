# App store listings read model: design

**Status:** slices 1 to 6 of 9 done, and slice 3b, all dark. Slice 1 is the adapter side of
`store-listing@v1` (`src/server/registry-adapter/listing-stream.ts`). Slice 2 is the app-index-go
ingest behind `APP_INDEX_LISTINGS` (`internal/index/listings.go`, `internal/store/listing*.go`;
README, "Listings read model"). Slice 3 is the read API, `GET /listings` and `GET /listings/{slug}`
(`internal/listingread`, `internal/api/listings.go`; README, "Listing API"). Slice 3b adds the
listing id and the public detail fields to the stream, the read model and the API (Rollout, below).
Slice 4 is the site's shadow of the store grid and the public REST list behind the
`app-listings-read-model` Flipt flag (`src/server/services/blocks/app-listings-read-model-shadow.service.ts`;
Shadow diff, below). Slice 5 serves the store grid and the public REST list from the read model at
the flag's `serve` variant (`serveListingPage`, same module; Serving, below), to be set per surface
only after the gate below. Until then every listing read is served from the database. Slice 6 puts
the store's sub-listing cards in the stream, the read model and the API (Sub-listings, below), so
the `/apps` grid page, which always asks for them, can be shadowed and served like the grid's other
callers (Serving, "What `grid` covers").

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

### Fields in slice 3b

New optional properties of `@v1` (additive, per `schemas.ts`), each exactly as `getListingDetail`
serves it to an anonymous viewer, by the detail's own rules (`listingExtrasFromRow` in
`catalog-source.live.ts`). Only the fork parent is viewer-scoped on the site, and the stream leaves
that judgement to the read model.

| Field                              | Source, and its rule for a viewer who is not the owner                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                               | `app_listings.id`: the card's key and the store's tie-break                                                                                                                       |
| `appBlockId` (on-site)             | the card's `kindData.appBlockId`                                                                                                                                                  |
| `serialId`                         | `app_listings.serial_id`, the comment thread's key                                                                                                                                |
| `collaborators`                    | accepted and displayed seats, banned and deleted users left out (`loadDisplayedCollaboratorChipsMany`, the detail's rule)                                                         |
| `sourceRepoUrl`, `issueTrackerUrl` | the detail's links, from the reads the detail uses (batched)                                                                                                                      |
| `actionsRunSource` (on-site)       | the serving version's submitting run, public repositories only (`readLiveActionsRunSourcesForBlocks`)                                                                             |
| `scopes`, `connectScopes`          | `listingDetailScopes` (on-site, approved scopes) and `listingDetailConnectScopes` (off-site, only with a connect client)                                                          |
| `betaMessage`                      | `publicBetaMessage`: the note only while `isBeta`                                                                                                                                 |
| `forkable`                         | `publicForkable`: the opt-in, on-site only                                                                                                                                        |
| `connectClientId` (off-site)       | `publicConnectClientId`: the public OAuth client id the detail's off-site `kindData` carries, null without one. Never on the card                                                 |
| `forkOf{slug}`                     | null unless a fork; `slug` names the parent only when it is in the same catalog and the subscription may read it (as the app entity's `forkOf`), else null. See Fork parent below |

Each detail field is one more batched read per catalog poll (byline, beta, support link, fork facts,
submitting run), run only while the listing stream is on. They read through the detail's own
degrade rules: a failed beta, support-link or run read publishes "none" until the next good read, as
the detail page shows; a failed fork or collaborator read fails the listing stream only.

**Fork parent.** The site's detail names the parent only to a viewer who may open the parent's store
page, and reads a hidden, removed or deleted parent the same, `{visible: false}`
(`resolveForkAttribution`). The read model does the same per request: it looks the named parent up
in its own generation and applies the same viewer gate (`Admits`). A parent outside the public
catalog is never named in the stream, so it can only read `{visible: false}`.

Never in the stream: `visibility` and `restrictedAudience` (viewer-scoped). `connectClientId` is
carried, off-site only, because the public detail shows it (`kindData`); the card still omits it,
and so does the read model's card. Listing media items are filtered per subscription by each
item's own rating under the app-rating rule (Media, below), which is coarser than the store's
per-request ceiling. The creator chip's `image` is the user's avatar, carried as the public card
carries it.

### Sub-listings (slice 6)

The store grid mixes sub-listing cards (`SubListingCard`: an item a parent app placed in the store)
into its pages when the request asks for them (`includeSubListings`, behind `app-store-sub-listings`).
The `/apps` grid page always asks. The child arm of `listAvailableListings` shows an item when its
parent is in the grid for the viewer, it is approved, its author is not banned or deleted, its
parent's sub-listing switch is on, its link works (an approved block on-site, a link template
off-site), and the mature rule admits its own rating.

**Decision: the items travel in their parent's body, as `subListings`, not as an entity of their own.**
This is the smallest change that keeps parity:

- An item is in the grid only while its parent is, so carrying it in the parent's entity makes that
  rule structural: a parent the stream deletes takes its items with it, and the read model never
  holds an item whose parent it does not hold, or one from another generation than its parent's.
- The item card's parent fields (id, slug, name, kind, category) and its image fallbacks (the
  parent's own icon and cover) are already in the parent's body.
- No new schema, URN kind, relay gate, consumer, generation or cursor. A second entity type would
  need all of those, and a join across two streams that can each lag the other.

**The cap.** A body carries at most `MAX_STREAM_SUB_LISTINGS` (200) items (`capSubListings`,
`catalog-media.ts`). A listing has no limit on its items but `maxPerAuthor`, and the grid pages
through all of them, so its page size bounds nothing. The bound is the stream line: a body travels as
one registry stream line, and app-index-go reads lines of at most 1 MiB (`MaxLine`,
`internal/registry`); a longer one ends the stream `unavailable` and replays from the same cursor
forever, wedging the listing stream for every index. An item is about 0.6 KB of JSON with short ASCII
text and at most about 1.9 KB with every field at its bound (computed, and pinned by a test that
builds 200 such items into a body: under 512 KiB), so 200 items leave more than half the line for the
rest of the body. Past the cap the adapter keeps the most recently approved items (the `newest` order:
`sortTime`, then id, descending, so the same catalog keeps the same items), says how many it left out
(`subListingsOmitted`), counts them on `registry_adapter_listing_sub_listings_dropped_total` (per
catalog read) and logs the listing id. The read model holds the count (`sub_listings_omitted`) and
names such listings on every `subListingIds` answer (`cappedListings`); the shadow counts a
database-page item of one of them that the read model does not hold as `sub_listing_cap`, a known
difference outside the gate and outside the order, never as `visibility_missing`. A listing over the
cap is served from the read model without its oldest items, which is why the count is reported: a
nonzero `sub_listing_cap` before `serve` is read, and the cap raised or the items split into an
entity of their own if a listing needs more.

The cost: a parent's body, and so its upsert, grows with its items, and any item change re-sends the
parent. Sub-listings change at review cadence, not rollup cadence, and the catalog is small; split
them into an entity of their own if a parent's body or upsert volume becomes a measured problem.

Each item (`ListingSubListingItem`, `registrySubListing` in `catalog-media.ts`) is read by
`readStoreSubListingsOfParents` (`app-sub-listing-store.service.ts`) for the public catalog's
listings, through the same child-arm predicate the grid uses (`subListingStoreArmWhere`) and the
hydration's re-check, with every rating (the read model gates per request). It carries the card's own
values, built with the card's own rules, so the read model ports no link builder:

| Field                                             | What                                                                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                              | the item's `asl_` id: the card's key and its tie-break                                                                                                                               |
| `title`, `tagline`, `author{id, username, image}` | the card's name, tagline and creator chip                                                                                                                                            |
| `contentRating`                                   | the item's own rating, which the store's mature rule reads (`subListingMatureFilter`, `s.content_rating`)                                                                            |
| `cardContentRating`                               | the card's rating, the stricter of parent and item (`effectiveSubListingRating`): what the card shows and caps its images at                                                         |
| `sortTime`                                        | `COALESCE(approved_at, created_at)` to the microsecond: the item's `newest` key                                                                                                      |
| `runHref`, `external`                             | the card's link: under the parent's run route (`subListingRunHref`), or an off-site parent's link template filled in (`subListingExternalHref`). An item with neither is not carried |
| `image{url, nsfwLevel, rating}`                   | the item's own image at cover width, rated on its own, only while it is in a public post and passes the per-image moderation check at every level (as a media item); else null       |

A subscription receives the items whose card rating its audience admits, and an item's image only
when its own rating is admitted (`readableBy`), as with the media. The read model, reading as a
service, gets every item.

**The read model's card** (`listingread.ProjectSubListingCard`) applies one ceiling to every image on
it, `subListingImageCeiling`: the viewer's levels (the public floor when none, on any host) ∩ SFW ∩
the levels up to the card rating, lifted on a red-capable host by `redHostMediaCeiling`. It differs
from a listing card's `listingMediaCeiling` by the viewer term: an anonymous viewer is shown no PG-13
image on an item card. The cover is the item image when visible, else the parent's own cover when
visible; the parent icon is the parent's own icon when visible. Never a civitai.red override and
never a screenshot, as the database card reads only the parent's `cover_id` and `icon_id`. The rule is
pinned on both sides by the parity fixture's `subListings` (`parity_test.go` TestSubListingParity,
`listing-media-parity.test.ts`).

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
| Media above the viewer's level                                                           | per image, `listingMediaCeiling`                  | Per item, from its `nsfwLevel`, with the same ceiling and the same red-override preference (Media, above; `listingread.ProjectMedia`); a sub-listing card's images at `subListingImageCeiling` (Sub-listings, above)                      |
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

- **Paging:** keyset on `(sortKey, id)`, with an opaque cursor, as the database does.
  `top-rated` pins the mean in the cursor for the whole session, as `decodeListingCursor` does. The
  limit is 1–50, default 20. The read model's cursors carry their own version (`rm2`; `rm1` was the
  slug-keyed cursor before slice 3b), so a database cursor sent to it, or one of its own sent to the
  database, pages from the start.
- **Filters:** `kind`, `category` and `userId` (developer filter). Text search stays the site's: it
  asks the app index (`/search`, under its `viewerNotRoutable` rule) for slugs, and hydrates them
  from the read model (`slugs`) instead of from the database.
- **Known divergences,** each measured by the shadow diff rather than assumed small:

  - `getGlobalRecommendMean` averages over every approved listing, restricted ones included. The
    read model sees public listings only. If the order moves materially, the adapter can publish the
    mean as a single `service@v1` parameter.
  - The keys and ids compare as bytes; the database compares them under its collation. Only the
    `name` sort can differ (punctuation, case-folded non-ASCII): ids are `apl_` and a ULID, which
    order the same either way.

- **Sub-listing cards** (`subListings=1`, sent when the database read has `includeSubListings`):
  the same order as the database's union of listings and items, `(sort key, tb, id)` with tb 0 for a
  listing and 1 for an item, ascending in every sort, so a listing comes before its items on one key.
  An item takes its parent's key for `top-rated` and `popular`, and its own `sortTime` or title for
  `newest` and `name`. A cursor on an item carries its key and `asl_` id, and both sides read its tb
  from the id; without sub-listings such a cursor resumes after its key, as the parents-only
  statement does. The format is still `rm2`: a cursor's fields and every position an earlier one could
  name mean the same as before, so no version bump.
- A text search the app index answers (`app-index-search`) still takes its sub-listing cards from
  the database page (`withSubListingCards`); it is a search, not a grid page.

## Shadow diff

Slice 4 shadows the store grid (`appListings.listAvailable`, every page) and the public REST list
(`GET /api/v1/apps`). Detail, card and OG are slice 7. With the `app-listings-read-model` Flipt
flag at `shadow` (Cutover flags), the site serves the database answer exactly as before, and
afterwards, off the response path, asks the read model the same query and compares the two
(`app-listings-read-model-shadow.service.ts`). At `serve`, a page served from the read model is
compared the other way round (Serving, below).

- **The viewer.** The token is signed from the options object the database read was given
  (`app-index-viewer-token.ts`): `host` from `redCapable`, `level` from `viewerBrowsingLevel`
  (absent is 0), `scope` narrowed by `narrowStoreScope`, the same defaults the database read applies.
  A floor other than `public`, or a level that is not an integer from 0 to 63, is not shadowed.
  `viewer_test.go`'s literal vector pins the signer on both sides.
- **Not shadowed:** a page the app index's search answered. A page with sub-listing cards
  (`includeSubListings`) asks the read model for them (`subListings=1`); an answer that does not say
  it has them (`"subListings": true`, absent from a read model that ignored the parameter) is
  `bad_response`. A cursor after a sub-listing card is moved like any other (Sort and paging).
- **Paging.** A database cursor `(sort_key, id, mean)` is sent as the read model's cursor with the
  same three fields, so both sides rank page 2 onward from the same position with the same pinned
  mean, and no database read is needed for it. A cursor-format literal is pinned on both sides
  (`rank_test.go` `TestCursorVector`, the shadow's test).
- **Compared by listing id.** A read-model card without its `id`, or an on-site one without
  `kindData.appBlockId`, makes the answer `bad_response`. Each listing is named by its slug in the
  checks and the log:
  - a sub-listing card is matched by its id too, and named by it (it has no slug). One on one page
    only is asked of the other side by id, with the same kind, category and developer filter
    (`?subListingIds=` on the read model, which must mark its answer; `listStoreSubListingsByIds` on
    the database), and counts as a visibility or order mismatch exactly as a listing does. On both
    pages its cover and parent icon are **media** (`coverUrl`, `parentIconUrl`), and its name,
    tagline, kind, category, rating, creator, parent (id, slug, name) and link (`runHref` with
    `external`) are **identity** fields. One id naming a listing on one side and a sub-listing on the
    other is the `id` identity field;
  - a listing on one page only is asked of the other side by slug, with the same kind and category
    (`?slugs=` on the read model; `listStoreListingsBySlugs` on the database, plus the developer
    filter). Not shown to this viewer at all there: a **visibility** mismatch,
    `visibility_missing` (the read model hides a listing the database shows) or `visibility_extra`
    (the read model shows a listing the database does not; the dangerous one). Shown there: the two
    sides only page or order it differently, which is an order mismatch. A database card and a
    read-model card left unmatched that share a slug are one slug naming two listings: the `id`
    identity field, counted as `identity_field`, never as visibility or order;
  - a listing on both pages: its gated media (`iconUrl`, `coverUrl`) is a **media** mismatch when it
    differs; an **identity field** (`name`, `tagline`, `category`, `contentRating`, `creator`,
    `isBeta`, `isOfficial`, `kindData` with its `appBlockId`) an `identity_field` mismatch; and a
    **stats field** (`recommendedCount`, `notRecommendedCount`, `recommendPct`, `reviewCount`,
    `openCount`, `updatedAt`) a `stats_field` mismatch. Identity fields say what the listing is, and
    a difference there is a read-model bug; stats fields can trail the database by up to an adapter
    poll (Stats freshness). The classes are `READ_MODEL_FIELD_CLASS`, pinned field by field by the
    shadow's test;
  - **order**, reported apart: the listings left once visibility mismatches are removed differ in
    order, or one side has a next page and the other does not. Both sides break ties by id, so an
    order mismatch is a paging or ranking difference (the global mean, a stats change between the
    two reads, the name collation); it never counts as visibility.
- **Bounded:** a sampled fraction of pages (`APP_LISTINGS_READ_MODEL_SHADOW_SAMPLE`, default 0.1),
  at most `APP_LISTINGS_READ_MODEL_SHADOW_MAX_IN_FLIGHT` per process at a time (default 4; more are
  dropped, never queued), each read-model call and each of the shadow's own database reads waited
  on for at most `APP_LISTINGS_READ_MODEL_SHADOW_TIMEOUT_MS` (default 1000; a database read past it
  is not cancelled, only no longer waited on), and a per-process breaker (`IndexBreaker`, with the `APP_INDEX_BREAKER_*` knobs):
  after consecutive read-model failures the shadow stops for a cooldown. The breaker is asked only
  immediately before the first read-model call, so a page that returns earlier never spends its
  half-open probe. The one extra database read is the by-slug check, only for a page that differs.
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
up to an adapter poll, and the order can move with it. A listing whose stats differ persistently
(across more than two polls), or a surface whose order mismatches persist, is still read before
serving.

### Serving (slice 5)

At the flag's `serve` variant, `serveListingPage` reads a store grid page, or a public REST list
page, from `GET /listings` instead of from the database, when the read model can answer it:

- **User-facing only.** The database answers, and the read model is not asked, for a moderator
  (whatever floor they read the store at), a floor other than `public` (testers, moderators), a
  level that cannot be signed, and a cursor that names no card. A grid request the app index searches (`app-index-search` on, with a text query) is a
  search, not a grid page: it, and every database read it makes, its fallbacks included, stays as
  it was (`StoreGridReads.gridPage`). Owner, creator and moderator screens, detail, card, OG and
  testers-only or private listings never call it (What stays on the database). Every served
  card's `restrictedAudience` is null: a `public`-floor viewer is told no restricted level.
- **What `grid` covers.** Every caller of `appListings.listAvailable` that the index does not
  search: the `/apps` grid page (`AppListingsMarketplaceBody`), which always asks for sub-listing
  cards (`includeSubListings: true`, granted with `app-store-sub-listings` by `storeGridRequest`),
  the listing page's related rail and the developer filter ("More by this developer", the profile
  Apps tab), which ask for none. A page with sub-listing cards is served with the read model's cards
  (`servedSubListingCardOf`: its gated media and its link as they are) when its answer says it has
  them; an answer without the mark, or a sub-listing card in an answer to a request that did not ask
  for them, is `bad_response` and the database page is read instead. `rest_list` never asks for
  them.
- **Fallback.** A timeout (`APP_LISTINGS_READ_MODEL_SERVE_TIMEOUT_MS`, default 400), a 503, any
  other failure, a body that does not parse, a card that cannot be a store card (an on-site card
  without `hasPage` and `liveUrl`, or a `kind` that is not its kind data's), or a next cursor that is
  not a read-model cursor: the page is read from the database, once, and that read's own failure
  is the request's, as with the flag off. A fallback costs the read model's failure plus the
  database read.
- **Breaker.** The shadow's per-process breaker (`IndexBreaker`, `APP_INDEX_BREAKER_*`), shared by
  serving and the comparison: each serve attempt asks it, and answers it with the read model's
  outcome. While it is open every page is read from the database without asking the read model.
- **Media ceilings.** The viewer token is signed from the options the database read would have
  been given (`host` from `redCapable`, `level` from `viewerBrowsingLevel`, `scope`), and the read
  model gates each item by `listingMediaCeiling` and `redHostMediaCeiling` (`listingread.ProjectMedia`,
  pinned to the site's rule by `media-parity.json`). The site serves its `iconUrl` and `coverUrl`
  as they are; it holds no media of its own for a served page.
- **Paging.** The client's cursor is always the database's format: a database cursor is moved to
  the read model's terms as the shadow does, and a served page's next cursor (`rm2`) is re-encoded
  as a database cursor at the same `(sort key, id, mean)` (`decodeReadModelCursor`,
  `encodeListingCursor`). So page 2 can be read from either side, if the flag flips or the read
  model fails between two pages, from the same position with the same pinned mean.
- **Comparison.** A sampled fraction of served pages (the shadow's sample, in-flight cap and
  timeout) reads the database page off the response path and is compared exactly as a shadowed
  page is, with the same counters and log line. A database read failing or outliving the timeout
  there is `db_error` or `db_timeout`, and never moves the breaker. At `serve` the shadow of
  database-served pages stops: those are the pages the read model could not serve.
- **Metrics.** `app_listings_read_model_serve_requests_total{surface, outcome}`: `served`, or why
  the database answered: `unconfigured`, `unsupported_viewer`, `unsupported_input`,
  `breaker_open`, `timeout`, `not_ready`, `error`, `bad_response`.

### Turn-on order

Nothing before the flag changes what any user sees. Each step is reversible by undoing it, in
reverse order: in particular **roll app-index-go back before the adapter**. An adapter rolled back
below the layout the serving index requires (say, slice 6's `subListings` under a layout 4 index)
sends bodies that index cannot use. A serving listings generation keeps its last good row for such
an upsert (counted `invalid`; `Consumer.KeepInvalidWhileServing`) rather than deleting it, so the
API keeps serving the last good listings, but they go stale until the index is rolled back too and
rebuilds at the older layout.

1. The adapter publishes `listingContentRating` (slice 3) and the listing `id` and detail fields
   (slice 3b), so the read model holds every listing at layout 3. This must be deployed before an
   app-index-go of layout 3 ingests: its ingest treats a body without `id` as unusable, and would
   hold an empty first snapshot rather than serve one.
2. `APP_INDEX_LISTINGS=on` on app-index-go, after the service identity and the listing relay gate
   it needs (Rollout, slice 2), and its first listings generation is serving.
3. The viewer key on both sides: the same secret of at least 32 bytes as `APP_INDEX_VIEWER_KEY` on
   app-index-go and on the site. `APP_INDEX_URL` is already set on the site for search.
4. The `app-listings-read-model` flag created, as a variant flag (variants `shadow` and `serve`;
   Cutover flags), and set to `shadow`. The flag lives in the Flipt state repository, not in this
   repo; until it exists every page is read from the database.
5. The adapter publishes `subListings` (slice 6) before an app-index-go of layout 4 ingests: that
   ingest treats a body without it as unusable, and holds an empty first snapshot rather than serve
   listings without their items. The layout 4 generation is rebuilt beside the serving one, and the
   API answers 503 from an older layout until it switches.
6. Per surface, once the gate above passes for it, and only once an app-index-go of layout 4 is
   serving: the flag at `serve` for that surface (a rule on
   the `surface` context, `grid` or `rest_list`). Back to `shadow` is the rollback. For `grid` the
   gate is measured on every grid read the index does not search, the `/apps` grid page with its
   sub-listing cards included (Serving, "What `grid` covers"); a `grid` gate measured before slice 6
   covered only the rail and the developer filter, and is measured again. A layout 3 index must not
   serve: it ignores `subListings=1` (its answer lacks the mark, so the web tier reads the database
   instead), but a cursor after a sub-listing card, from a page the database served, is read there
   as a listing position and can serve again the listings on that card's sort key.

## Cutover flags

Slice 1 added the first, slice 2 the second and slice 4 the third, which slice 5 widened.

| Flag                                            | Values           | What                                                                                      |
| ----------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------- |
| `REGISTRY_ADAPTER_LISTING_RELAYS` (adapter env) | relay client ids | the listing stream exists, for those relays only. Empty means off (this PR)               |
| `APP_INDEX_LISTINGS` (app-index-go env)         | on/off           | ingest `store-listing@v1` (slice 2), and serve the listing API (slice 3). Unset means off |
| `app-listings-read-model` (Flipt)               | variant          | the grid and REST list: `shadow` (Shadow diff) or `serve` (Serving); see below            |

The `app-listings-read-model` flag is a variant flag, evaluated per request surface for the global
entity with the context `surface` (`grid` or `rest_list`), at most once per 5 s per process per
surface (`readReadModelMode`):

| Answer                                                  | Mode       |
| ------------------------------------------------------- | ---------- |
| variant `serve`                                         | `serve`    |
| variant `shadow`                                        | `shadow`   |
| any other variant, no rule matched, the flag disabled   | `database` |
| the flag absent, not a variant flag, or Flipt not ready | `database` |

`database` reads every page from the database and asks the read model nothing. Serving has no
switch of its own: `serve` is the one way in, and any unknown answer is the database.

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
   - **Slice 3b (done):** the listing `id` (the card key and the database's tie-break) and the
     public detail fields, additive to `store-listing@v1` (Fields in slice 3b, above). The read
     model requires `id` (`ListingsLayoutVersion` 3: a `listing_id` column, rebuilt beside; the API
     answers 503 from an older-layout generation until the switch), ranks ties by it, returns `id`
     and `kindData.appBlockId` on cards and the detail fields from `GET /listings/{slug}`, and
     resolves the fork parent per viewer. The shadow compares by id, and moves a database cursor to
     the read model without a database read. The detail rule is pinned on both sides by the parity
     fixture's `details` (`parity_test.go` `TestDetailParity`, the site's `listing-detail-parity.test.ts`).
4. **Slice 4 (done): shadow** on the grid and REST list: the web tier signs the viewer token, calls
   `GET /listings` after its database read behind `app-listings-read-model`, serves the database
   answer, and compares (Shadow diff, above).
   - Also in slice 4: `GET /listings` ranks from a per-process memo of the serving generation's
     keys, read once per (generation, cursor) and shared by concurrent requests, instead of a scan
     of every listing per request (README, "Listing API").
5. **Slice 5 (done): serve grid and REST** at the flag's `serve` variant, per surface and after
   the gate (Serving, above), with the flag reshaped as a variant (Cutover flags).
6. **Slice 6 (done): sub-listings in the read model.** The adapter carries each listing's
   sub-listing items in its body (`subListings`; Sub-listings, above); the read model requires them
   (`ListingsLayoutVersion` 4: a `sub_listing_keys` column holding each item's key fields for the
   ranking memo, rebuilt beside; the API answers 503 from an older-layout generation until the
   switch), ranks them into a page with `subListings=1` in the database's order, hydrates them by id
   (`subListingIds`), and gates and projects each per request. The shadow and serving answer pages
   with sub-listing cards, and after one, instead of refusing them (`unsupported_input`). The card
   rule is pinned on both sides by the parity fixture's `subListings`, and the stream's read is
   executed against the grid's child arm on the same rows (`app-sub-listing-store.behavior.test.ts`).
7. **Slice 7: shadow, then serve, detail, card and OG.**
8. **Slice 8: launch and install** via `app-release@v1`.
9. **Promotion** to the official registry: drop the relay gate, once the registry owner agrees.

## What stays on the database

- Owner and creator screens: My apps, builds, drafts, submit and edit, revisions, analytics.
- Moderator screens: the review queue, moderation listing, takedowns, history.
- Tester and moderator store views (`floor !== 'public'`).
- A text search's sub-listing cards (`withSubListingCards`, with the search's database page).
- Writes of any kind, and every read inside a write transaction.
- The "restricted audience" badge, which is viewer-scoped and only shown to non-public floors.
- Fork lists and fork sessions.
- The developer track record (`getDeveloperTrackRecord`).
