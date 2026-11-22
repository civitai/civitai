# app-index-go

A search index of the apps a registry streams. It subscribes to the app entity schema
(`urn:schema:apps.civitai.com:app@v1`, published by the registry adapter in
`src/server/registry-adapter/`), keeps every app in its own Postgres database, and answers
`GET /search`. The index is a cache: it can always be rebuilt from the registry. Its shape follows
the registry spec's model-index example.

The `/apps` store reads it for text search when the `app-index-search` Flipt flag is on for the
viewer (`src/server/services/blocks/app-index-search.service.ts`, `APP_INDEX_URL`). Any failed
call serves the store's database search instead, and a run of them opens a per-process breaker
that stops calling the index for a cooldown (`APP_INDEX_BREAKER_FAILURE_THRESHOLD`,
`APP_INDEX_BREAKER_COOLDOWN_MS`).

## HTTP

| Route          | What                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /search`  | `q`, `kind` (`onsite` / `offsite`), `category`, `mature` (below), `limit` (1-50, default 20) → `{results:[{urn, slug, name, tagline, kind, category, rating, iconUrl, creator}]}` |
| `GET /healthz` | the process is up                                                                                                                                                                 |
| `GET /readyz`  | 200 once a generation is serving (the first `Live`), 503 before                                                                                                                   |
| `GET /metrics` | Prometheus (`app_index_*`)                                                                                                                                                        |

With the listings read model on, two more routes answer for the web tier: `GET /listings` and
`GET /listings/{slug}` (below, "Listing API").

`mature` is the mature content ratings the caller's viewer may see: a comma-separated list of `r`,
`x` and `xxx` (`mature=r,x`). Absent or empty, `/search` answers only apps rated `g`, `pg` or
`pg13`, what the anonymous registry audience reads, so a caller that sends nothing gets SFW
results. With it, an app rated one of the listed ratings is answered too; an app whose rating is
none of the six (or missing) only with all three listed, the registry's own audience rule
(`audienceAdmits`). Ratings compare case-insensitively. Any other element answers 400. The filter
is in the store query, before `limit`, so a page is never short for it. The caller is trusted to
send its viewer's own set (the web tier derives it from the viewer's browsing level and host,
`indexMature` in `app-index-search.service.ts`); the parameter is part of the URL, so a shared
cache keys on it.

`q` matches word by word: every word must be a prefix of a word of the app's name, slug, tagline or
creator. Results are in relevance order, Postgres `ts_rank` (name above slug and tagline above
creator), then by name; without `q` they are by name. There is one page of at most `limit` results:
no other sort and no paging. `/search` answers 503 until the index is ready.

Every `/search` response, success or error, carries `Access-Control-Allow-Origin: *`, so an app
in a sandboxed iframe can call it from the browser: it answers only public listings and takes no
credentials. `OPTIONS /search` answers a CORS preflight (204, `GET`, `Access-Control-Max-Age`).
`/healthz`, `/readyz` and `/metrics` send no CORS header.

A 200 from `/search` is `Cache-Control: public, max-age=0, s-maxage=30`: a shared cache in front
of the service may hold it for 30 s and absorb repeated searches, while browsers revalidate every
time. Every other response, errors included, is `no-store`. A CDN only applies this to `/search`
once it treats the path as cacheable: the TTL lives here, and the CDN rule only opts the path in.

## Following the stream

- `Upsert` replaces the app's row, `Delete` removes it, `Progress` only moves the cursor. Each stores
  its cursor in the same transaction as its change, so after a crash the index holds exactly what its
  cursor says.
- `Live` stores its cursor. The first `Live` of a building generation makes it the serving one.
- `End` is logged and the subscription is opened again after the longest backoff.
- A restart resumes from the stored cursor. A stored empty cursor (a snapshot cut off before `Live`)
  starts over.
- `cursor_expired`, a `LayoutVersion` bump (`internal/index`), or a serving generation whose cursor
  is empty builds a new generation from an empty cursor while the old one keeps answering; the switch
  happens in one transaction at the new one's `Live`, and the old one is dropped.
- Any other end of the stream reconnects with the same cursor after an exponential backoff with
  jitter (`APP_INDEX_BACKOFF_*_MS`). A quiet stream is never treated as lost (the spec: a live
  stream may be silent for any length of time); there is no response-header or idle timeout. A dead
  connection is detected by the transport: TCP keepalive probes, and HTTP/2 PING frames over HTTP/2.
- An upsert whose body lacks a field the index relies on is treated as deleted. An event that
  cannot be decoded at all is skipped and counted (`app_index_malformed_events_total`), advancing
  the cursor only when it carried one, so it cannot wedge the stream.
- Only one process follows the stream (a Postgres session advisory lock); others serve searches.
  Writes to a generation also check that this process still owns it (`Postgres.Claim` says exactly
  what that guarantees).

The subscription is anonymous unless `APP_INDEX_REGISTRY_TOKEN` or a client is set, so the registry
serves it the audience anyone may read: SFW apps only.

### Subscribing as itself (client credentials)

With `APP_INDEX_CLIENT_ID`, `APP_INDEX_CLIENT_SECRET`, `APP_INDEX_TOKEN_URL` and
`APP_INDEX_TOKEN_RESOURCE` set, the index gets its own access token from the auth hub with the
OAuth client credentials grant (`internal/token`) and sends it on every subscription.
`APP_INDEX_TOKEN_RESOURCE` is the resource the token is for (the hub issues a service token only
for a named resource), and `APP_INDEX_TOKEN_SCOPE` is sent as `scope` when set.
`APP_INDEX_TOKEN_URL` must be https, or http only to a cluster-local service name (`*.svc`,
`*.svc.cluster.local`), since the client secret crosses that hop. The token is kept until 30 s
before it expires.

- A stream that ends with `invalid_token` (the token expired or was revoked) drops the token and
  subscribes again from the stored cursor, never an empty one, with a new token. This waits the
  ordinary backoff, which grows while the registry keeps refusing.
- A token that cannot be fetched opens no subscription and is retried with the same backoff
  (`app_index_reconnects_total{reason="token"}`). The stored cursor and the serving generation are
  kept.
- `app_index_token_fetches_total{outcome}` counts calls to the token endpoint.

Setting a client together with `APP_INDEX_REGISTRY_TOKEN`, or any of these settings without the
others it needs, refuses to start. Unset, nothing changes: no token is fetched and no
`Authorization` header is sent.

**Rollout order.** Configure the client last:

1. The auth hub: the index's service client, and `serviceSubjects` and relay listings on the
   resources its token is exchanged for.
2. The apps origin: `REGISTRY_ADAPTER_SERVICE_CLIENTS` names the index's client.
3. Only then this service's client settings. Search already filters mature apps per viewer: a
   `/search` without `mature` answers SFW apps only, so public search shows no mature app once the
   index holds them. The web tier still routes no viewer who may see a mature rating to the index
   (`viewerNotRoutable`, reason `mature_viewer`); lift that once the index holds mature apps, and
   each such call carries the viewer's `mature` (`indexMature`).

Configured before steps 1 and 2, every token is refused: the index stops taking in changes and
keeps retrying with backoff. Its stored cursor and serving generation are kept, and it catches up
once the steps are done.

**What to expect once it is on:**

- One `cursor_expired` rebuild at switch-on (`app_index_rebuilds_total{reason="cursor_expired"}`).
  The stored cursor names the anonymous audience, the origin refuses it for the service's, and a
  new generation is built beside the serving one.
- After that, `app_index_reconnects_total{reason="auth"}` rises about every 15 minutes: an
  exchanged token lasts at most that long, and each expiry ends the stream with `invalid_token`,
  which resumes from the cursor with a new token.

## Listings read model (dark)

With `APP_INDEX_LISTINGS=on`, the process runs a second consumer beside the app one: it follows
`urn:schema:apps.civitai.com:store-listing@v1` into tables of its own (`app_index_listing_cursors`,
`app_index_listings`), with its own generations, cursor and consumer
lock, and the same rules as above (`internal/index`). It shares the app consumer's subscriber and
token. Unset or `off`, nothing of it exists: its tables are not created, no `app_index_listings_*`
series is registered, nothing subscribes to the schema and the listing routes are not registered
(404). `/search` and `/readyz` are the app index's alone. The design and its later slices:
`LISTINGS-READ-MODEL.md`.

- **Media** are stored as the stream sends them, in the listing's body: the body is the one copy,
  and every read decodes them from it with the ingest's own decoder (less an item with an unknown
  slot, below). Each item keeps its own `nsfwLevel`, `rating` and `host` (`red` for a civitai.red
  override). No ceiling is applied at ingest. The stream's per-audience filter is coarser than the
  store's, so the listing API applies the listing-rating ceiling and the host rule per request
  (`internal/listingread`). Slice 2 also kept each item as a row of `app_index_listing_media`; that
  table is dropped at startup, since nothing read it and the bodies hold the same items.
- **An empty snapshot is held.** A snapshot that reaches `Live` with no listing is never switched
  to: the serving generation keeps every row, the hold is logged and counted
  (`app_index_listings_empty_snapshots_total`, `app_index_listings_reconnects_total{reason="empty_snapshot"}`),
  and the snapshot is taken again from an empty cursor after the longest backoff. With nothing
  serving yet, the read model stays not ready. This covers snapshots only: deletes that arrive one
  by one on a resumed stream are applied as they come.
- **`unavailable`** (the adapter's answer when its listing read failed) deletes nothing: the
  subscription is opened again from the stored cursor, like any other `unavailable`.
- A body missing an identity field (`app`, `id`, `slug`, `name`, `kind`, `contentRating`, `listingContentRating`), a
  detail field of the wrong type, or a media item
  whose host or rating is unknown or whose `nsfwLevel` is not exactly its rating's level (pg 1, pg13
  2, r 4, x 8, xxx 16), is treated as deleted (`app_index_listings_events_applied_total{type="invalid"}`):
  such an item could not be gated.
- What can be left out without misgating is dropped and the listing kept, each drop logged and
  counted (`app_index_listings_dropped_total{what}`): a media item with an unknown slot
  (`media_item`), and a stats counter that is missing, negative or not an integer (`stat`), stored
  as null.

What has to be in place before it is switched on: the service identity (above, "Rollout order"),
and the listing relay gate on the registry adapter (`REGISTRY_ADAPTER_LISTING_RELAYS`) naming the
relay this service subscribes through. Without them the subscription is either refused or answered
with an empty snapshot (which is held, as above), and retried with backoff; the app index is
unaffected. A second consumer lock needs `APP_INDEX_DB_MAX_CONNS` of at
least 3. A value of `APP_INDEX_LISTINGS` that is neither on nor off is read as off: the process
starts, logs an error and exposes `app_index_listings_misconfigured` (1), rather than refusing to
start and taking `/search` down with it.

### Listing API

`GET /listings` and `GET /listings/{slug}` answer the store grid and the detail page from the read
model, for the web tier only. The site calls `GET /listings` only in shadow, behind the
`app-listings-read-model` flag, and serves its own database answer (`LISTINGS-READ-MODEL.md`,
"Shadow diff"). Each is a port of the store's database read
(`listAvailableListings`, `getListingDetail`), and `internal/listingread` names the site function each
rule mirrors.

**The viewer.** This service never decides who is looking. The web tier resolves the request's
audience as it does for its own database read, and sends it in the `X-App-Index-Viewer` header as a
token signed with a key the two share (`APP_INDEX_VIEWER_KEY`, at least 32 bytes):

```
v1.<payload>.<signature>
payload   = base64url, unpadded, of {"host": "main"|"red", "level": <int>, "scope": "full"|"public-external"|"none", "exp": <unix seconds>}
signature = base64url, unpadded, of HMAC-SHA256(key, "v1." + payload)
```

- `host` is `red` when the request's host is red-capable (`isRedCapableHost`); `level` is the viewer's
  browsing level (0 to 63; 0 is the public floor); `scope` is the resolved store visibility scope
  (`resolveStoreVisibilityScope`). The payload's keys may be in any order; any other key is refused.
- `exp` is at most 5 minutes ahead (30 s of clock skew either way): the web tier signs one per
  request.
- Only an audience-floor-`public` viewer is ever sent; testers and moderators stay on the database.
- A missing, malformed, wrongly signed or expired token is 401 `bad_viewer`, and nothing is read. An
  unknown scope is `none`, as `narrowStoreScope` reads it. With the key unset or short, every listing
  request is 503 `unconfigured`.
- **Key rotation.** `APP_INDEX_VIEWER_KEY_NEXT` (optional, at least 32 bytes) is a second key a
  token may be signed with; the signature is compared against both, each in constant time. To
  rotate: set the new key as `APP_INDEX_VIEWER_KEY_NEXT` here, move the web tier's signer to it, then
  make it `APP_INDEX_VIEWER_KEY` and unset the next one. No request is refused along the way. A next
  key that is set but short is a misconfiguration: every listing request is 503 `unconfigured` and
  the process logs an error at start, as for a short current key; it is never ignored.
- `internal/listingread/viewer_test.go` holds a literal token for a test key, computed outside Go, for
  the web tier's signer to be tested against.

**The gates, per request.** A listing is answered only when the scope admits its kind (`none`
nothing, `public-external` off-site only) and the mature rule admits its rating (`r`, `x`, `xxx` only
on a red host and only with that bit in the level). The rating gated on, and shown on the card, is
the listing's own (`listingContentRating` in the stream; null is not mature, and its media ceiling
is PG), never the app entity's `contentRating`, which falls back to the block's. Its media are projected for the viewer
(`projectListingMedia`): the listing-rating ceiling, lifted on a red host by the viewer's levels;
the civitai.red overrides only on a red host, preferred over the own image of their slot; the
cover falling back to the first visible screenshot. A listing the viewer may not see is a 404,
exactly like a missing one.

| Route                       | Parameters                                                                                                                                                 | Answer                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `GET /listings`             | `sort` (`top-rated` default, `popular`, `newest`, `name`), `kind` (`all`, `onsite`, `offsite`), `category`, `userId`, `cursor` (≤ 512), `limit` (1-50, 20) | `{items: [card], nextCursor?}` |
| `GET /listings?slugs=a,b,c` | up to 50 slugs (each ≤ 64 bytes), `kind`, `category`; no `cursor`, no `userId`                                                                             | `{items: [card]}`              |
| `GET /listings/{slug}`      | the slug (≤ 64 bytes)                                                                                                                                      | the detail, or 404             |

- The sorts and the keyset paging are the store grid's: the same sort keys, `top-rated` with the
  global mean pinned in the cursor for the paging session. The global mean is over the listings the
  read model holds. Ties fall to the listing id, as on the database, and a cursor carries the sort key
  and the id (`rm2`), the database cursor's own fields. A cursor that is not this service's format
  (the database path's `v2` cursors, an earlier layout's slug-keyed `rm1`, or anything that does not
  decode) pages from the start. Cursors are not signed: any well-formed one
  is accepted and only positions the page, which every viewer may read from any position anyway.
- `slugs` hydrates a search the site answered itself: the site keeps its text search where it is
  (the app index's `/search`, routed by its own `viewerNotRoutable` rule) and asks here for the cards
  of the slugs it found, as `listStoreListingsBySlugs` does from the database. They come back in the
  given order, each once, through the same gate and filters as the list; a slug the viewer could not
  find in the grid is left out. There is no text search here: `q` is refused (400).
- A card is the site's `ListingCard`, `id` and the on-site `kindData.appBlockId` included;
  `restrictedAudience` is always null. A detail adds `description`, `installCount`, `screenshots`
  and the public detail fields (`serialId`, `collaborators`, `sourceRepoUrl`, `issueTrackerUrl`,
  `actionsRunSource`, `scopes`, `connectScopes`, `betaMessage`, `forkable`, `forkOf`). `forkOf` is
  resolved per viewer, as `resolveForkAttribution` does: the parent is read from the same generation
  by the slug the stream names, and named only when this viewer may see it; a parent hidden from the
  viewer, outside the stream or gone reads `{visible: false}`. An off-site detail's `kindData`
  carries `connectClientId` as the stream sends it; the card's never does.
- Every response is `no-store` and carries no CORS header. A store failure is 500, never an empty
  page. A read that races a generation switch is 503: each store read checks, after reading, that its
  generation still exists. A serving generation of an older row layout is 503 too, until the rebuild
  beside it switches over.
- The gate and the filters run twice: on the rows a page is ranked from, and again on the rows its
  cards are projected from, since the consumer keeps writing the serving generation between the two
  reads. A listing re-rated or re-kinded in between is left out, so a page can be short by it; it is
  never shown to a viewer it no longer admits.
- **Keys are memoised.** A page is ranked from every listing's columns (`Keys`). The process holds
  the last answer for the serving generation and its cursor, and reads it again only when either
  moves (every change the consumer commits moves the cursor in the same transaction); concurrent
  requests that miss share one read, which runs within `APP_INDEX_SEARCH_TIMEOUT_MS` and is not
  cancelled by the request that started it. A page then costs one read of its own rows. The sort
  stays in Go rather than SQL so `internal/listingread` remains the one port of the store's sort
  keys, paging and gates (`internal/api/listings_keys_memo.go`).
- `app_index_listings_requests_total{route, outcome}` counts them.

The media rule is pinned on both sides by one fixture, `internal/listingread/testdata/media-parity.json`:
`parity_test.go` runs it through the read model; the site's `listing-media-parity.test.ts` runs it
through `projectListingMedia`, the store gate and the adapter's `registryListingMedia` and
`listingBody`, and `listing-card-parity.test.ts` checks its card stats against `recommendRollup` and
`cardOpenCount`.

## Configuration

See `.env.example`. `APP_INDEX_REGISTRY_URL` and `APP_INDEX_DATABASE_URL` are required. The service
creates its tables at startup (`internal/store/postgres.go`); point it at a database of its own.
`APP_INDEX_DATABASE_URL` must be a direct (session) connection, never a transaction-mode pooler: the
consumer lock is a session advisory lock, which such a pooler does not hold.

## Tests

```
go test ./...                                              # unit: in-memory store, fake registry
APP_INDEX_TEST_PG_URL=postgres://… go test -tags integration -run Integration ./...   # Postgres
```

The unit tier runs the store contract and the consumer scenarios against the in-memory store; the
integration tier runs the same contract and scenarios against Postgres. CI runs both
(`.github/workflows/app-index-go.yml`).

## Releasing

`pnpm run release:app-index-go` bumps `package.json` and cuts an `app-index-go-vX.Y.Z` tag
(`scripts/release-app.mjs`). Building an image from that tag needs a tag-webhook entry for
`app-index-go`, which does not exist yet.
