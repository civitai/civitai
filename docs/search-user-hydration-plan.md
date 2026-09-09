# Search: hydrate user data at read time instead of denormalizing it

**Status:** proposal, not started. Supersedes PR #4711 (closed).
**Origin:** ClickUp 868m22z20 — "Replacing an avatar leaves a dead `user.profilePicture` on every collection that user owns."

## The problem

Five Meilisearch indexes bake a copy of the owner's user record into every document that
owner owns. The copy goes stale the moment the real record changes, and nothing in the
incremental sweep can notice: every `prepareBatches` filters on
`"createdAt" >= lastUpdatedAt`, so an **existing** document is only ever rebuilt by an
explicit enqueue.

For the avatar the staleness then becomes visible breakage. `remove-replaced-images`
destroys the previous image 30 days after it is replaced, so the stored copy stops
resolving and the card renders a broken image.

### Measured, on production

| index | documents | max owned by one user | sampled avatar staleness |
|---|---:|---:|---|
| `images_v6` | 63,839,039 | 831,541 | not sampled |
| `models_v9` | 705,747 | 14,372 | **69 of 120 stale** |
| `collections_v3` | 95,907 | 8,987 | **100 of 120 stale** |
| `bounties_v3` | 9,096 | 67 | — |
| `comics_v1` | 0 | 48 | index is empty |

Staleness was measured by taking documents whose owner has a pending
`ReplacedImageDelete` row and comparing the document's `user.profilePicture.id` against
`User.profilePictureId` in the database.

Username is a different story: 200 `models_v9` documents compared against the database
found **0** stale usernames. The field that is expensive to keep fresh and the field the
index actually needs for matching are not the same field.

## Why the enqueue approach was abandoned

PR #4711 resolved the documents a user owns and queued them for rebuild whenever
`profilePictureId` changed. It does not scale to the surface:

- A single owner has up to **14,372** published models and **831,541** images. That is
  not a fan-out, and no cap makes it one — capping means most of the documents stay
  stale, which is the bug.
- It was reaching only `collections` and `bounties` in practice. `models` was missed
  outright, and `comics_v1` holds no documents.
- Every new trigger has to be found and wired by hand. Two were already known to be
  uncovered: `Image.onDelete: SetNull` clears `profilePictureId` in the database with no
  application code involved, and `/intent/avatar` writes the legacy `User.image` column.

The denormalized copy is the defect. Removing it removes the whole class, including the
triggers nobody has found yet.

## What has to stay in the document

This is **not** "stop storing user data".

- `user.username` is **searchable** in `models`, `images`, `bounties`, `comics`, and
  **filterable** in `collections`. Meilisearch needs it in the document to match on it.
- `user.id` / `userId` must stay — it is the hydration key.

What moves out is the display-only payload: `user.profilePicture` (a full nested image
record, the largest part of the object) and most likely `user.cosmetics`.

## What react-instantsearch actually gives us to hook into

Checked against the versions this repo pins — `react-instantsearch` **7.12.0**,
`instantsearch.js` **4.64.1**, `@meilisearch/instant-meilisearch` **0.13.5**. This is
version-specific; re-check it before acting on it after an upgrade.

The library has three extension points that look like they could decorate hits. **Two of
them cannot**, and the reason is the same in both cases: they are synchronous.

**`transformItems` — synchronous, cannot fetch.**

```ts
// node_modules/instantsearch.js/es/types/widget.d.ts:142
export type TransformItems<TItem, TMetadata = TransformItemsMetadata> =
  (items: TItem[], metadata: TMetadata) => TItem[];
```

It returns `TItem[]`, not `Promise<TItem[]>`. Every widget that accepts it — `useHits`,
`useInfiniteHits`, the refinement widgets — inherits that signature. It is for reshaping
data already in the response: mapping, filtering, reordering. It cannot go and get
anything.

**Middleware — no results hook at all.**

```ts
// node_modules/instantsearch.js/es/types/middleware.d.ts
export type MiddlewareDefinition<TUiState> = {
  $$type: string;
  onStateChange: (options: { uiState: TUiState }) => void;
  subscribe: () => void;
  started: () => void;
  unsubscribe: () => void;
};
```

Every member is a side-effect callback returning `void`. Middleware exists for routing
and analytics. Nothing in it can see, let alone modify, the hits.

**`searchClient.search(requests)` — the only async seam.** It returns a Promise, and it
is already where this codebase decorates: `baseSearchClient` short-circuits empty
queries, and `createResilientSearchClient` wraps failure handling around it.

There is a fourth option outside the library — call `useHits()`, then fire a React query
keyed on the user ids in the result. That is async, but it is a second independent
request from the browser, which is the partial-failure mode this design is trying to
avoid, and it renders cards once without an author and again with one.

So the choice is not "which widget do we use". The library offers exactly one place to
put this, and the real decision is which side of the network it sits on.

Worth knowing: Algolia documents no recipe for enriching hits from an external source.
Their model assumes the index is the source of truth, which is precisely the assumption
that does not hold for a mutable field owned by a different entity.

### The adapter runs server-side, so the response shape is free

InstantSearch expects Algolia's `MultipleQueriesResponse` shape, and
`@meilisearch/instant-meilisearch` is what translates Meilisearch's response into it.
That package depends only on the `meilisearch` SDK — no browser-only dependencies — so
**the proxy can import and run the same adapter server-side**.

That removes the biggest risk in the whole design. The proxy does not have to model
`facets`, `facets_stats`, `nbPages`, `exhaustiveNbHits`, `_highlightResult` or any of the
pagination fields, and cannot drift from what the widgets expect: it runs the adapter the
browser runs today, then decorates the hits, then returns. Widgets keep working unchanged
because nothing about the contract changes — only where it is fulfilled.

One consequence to note: hydrated fields arrive without highlight metadata. That is fine,
because everything being hydrated is display-only. `user.username` — the one user field
that is searchable — stays in the document and keeps its highlighting.

## The design: hydrate behind a server-side search proxy

### Why a proxy rather than hydrating in the browser

Hydrating client-side means the browser issues a second request after the search returns,
and the two can fail independently — leaving cards rendered with no author. A proxy makes
the response atomic from the client's point of view: one request in, one complete result
set out, one place that decides what happens when a dependency is down.

It is also fewer round trips, not more. Client-side hydration is necessarily serial —
the browser cannot ask for user records until Meilisearch has told it which users appear
— so it costs two sequential round trips from the browser. The proxy does the Meili query
and the cache reads server-side, next to both, and answers in one.

It also lets the search path reuse the server's existing Meilisearch failure handling —
`withMeili(...)` bounds every call at `MEILI_CALL_TIMEOUT_MS`, and `isTransientMeiliError`
already classifies brownouts. The browser-direct path had to reimplement that as
`resilientSearchClient` precisely because it could not reach any of it.

Finally, the pattern is already in the codebase: `getAllImagesIndex`
(`src/server/services/image.service.ts`) queries the image index server-side and fills in
`getBasicDataForUsers`, `getProfilePicturesForUsers` and `getCosmeticsForUsers` in
parallel. `metrics_images_v1` stores no `profilePicture` at all, and the image feed has
never had this bug.

### Shape

The proxy speaks InstantSearch's own multi-request protocol and passes the request array
through verbatim to the server-side adapter, so faceting, pagination and highlighting keep
working without the proxy modelling any of them:

```
POST /api/search
  body: the `requests` array InstantSearch passes to `searchClient.search`
  ->  server-side Meili query
  ->  collect userIds across every hit of every result
  ->  one batched read of userBasicCache + profilePictureCache (+ cosmetics)
  ->  splice into each hit
  ->  `{ results: [...] }`, the shape InstantSearch expects
```

The browser's `searchClient` then becomes a thin `fetch` wrapper — the same object shape
the widgets already consume, so no widget or component changes.
`searchForFacetValues` needs the same treatment; `resilientSearchClient` already wraps it,
so it is in use.

`resilientSearchClient` stays useful either way: it currently absorbs Meilisearch
outages, and after the cutover it absorbs outages of our own endpoint. Its retry and
error-classification logic may be able to shed the Meili-specific branches once the
browser no longer talks to Meilisearch directly — worth checking during step 2, not
assumed here.

Backend pieces that already exist: `profilePictureCache` (Redis, day TTL, SWR),
`userBasicCache`, `getCosmeticsForUsers`. What is missing is a single batched
"user records by id" entry point; none of the procedures in `user.router.ts` does this
today.

### Failure policy — decide once, here

Today the stale copy in the document doubles as a fallback. After this change there is no
copy, so a hydration failure means no author on the card. That trade is the point of the
change, but it has to be a decision rather than an accident:

- **Meilisearch fails** — unchanged from today: degrade to an empty result set and let
  the caller render the existing "temporarily unavailable" state.
- **Hydration fails** — return the hits with the user payload absent, and make it
  observable (a counter, not a silent null). A result set with missing avatars is far
  better than no results. This needs sign-off; it is the one place the proposal trades
  completeness for availability.

Two layers already sit under hydration: `createCachedObject` gives Redis a
stale-while-revalidate window, and a Redis miss falls through to the database. A total
hydration failure therefore means both are down.

## Migration order

Readers and writers cannot switch atomically, so expand/contract:

1. Build the batched user read and the proxy. Readers tolerate the document field being
   present **or** absent.
2. Cut the read paths over to the proxy — five client construction sites today
   (`SearchLayout`, `QuickSearchDropdown`, `AutocompleteSearch`, `search.client`,
   `CollectionSelectModal`), which is itself an argument for consolidating them.
3. Stop writing `user.profilePicture` in each index's `pullData`.
4. `reset()` the indexes to reclaim the field.

Step 3 before step 2 breaks search results. Step 4 before step 3 refills the field.

## Open questions

- **Load.** Autocomplete currently goes browser → Meilisearch on each keystroke.
  Proxying puts that traffic on the app servers. Needs sizing before step 2.
- **Edge caching.** A direct Meili GET can be cached in ways a proxied POST cannot.
  Worth checking whether anything currently relies on that.
- **Does this help the other Meilisearch problems?** Smaller documents and far fewer
  update enqueues *should* ease queue pressure, but that is a hypothesis — it has not
  been measured, and it should not be used to justify the work until it is.
- **`user.cosmetics`** has the same shape as `profilePicture` and probably moves with it,
  but its read paths have not been traced.

## What is not in scope

- `user.username` staying in the document. Meilisearch needs it to match, and it was
  measured fresh.
- Backfilling documents that already carry a dead avatar. They are fixed by step 4.
- The `deleteUser` path's *other* staleness (`username`, `deletedAt` on a deleted
  account), which hydration does not address because those fields stay in the document.

## Note on the field-count ceiling

An earlier version of this argument claimed the change would help with Meilisearch's
65,535-field index-wide map. It does not: Meilisearch reports a nested object as a single
entry in `fieldDistribution`, so removing `user.profilePicture` frees one field, not
fourteen. Recorded so the claim is not repeated.
