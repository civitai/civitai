# Semantic image search: the search page

`/search/semantic` searches images by meaning: a text query, or "more like this" from an image
(an item in the image card menu, shown with the flag). It
reads the vector index described in [semantic-image-search.md](semantic-image-search.md). It is a
test surface for now, shown only to those with the `imageSearch` feature flag.

## Access

- `imageSearch` gates image search on the search pages: this page, /search/images and the Images
  entry, "more like this", and both procedures. Its Flipt key is `semantic-image-search`; until that
  flag exists it falls back to moderators only. Once it exists, Flipt overrides the static list in
  both directions, so keep moderators in its rule.
- The page's `getServerSideProps` and both procedures (`semanticImageSearch.search`, `.feedback`)
  check that flag; `.search` also accepts `feedSearch` (below). Search is open to signed-out visitors (rate-limited per IP at 20 a minute,
  60 for signed-in users); feedback requires a signed-in user.
- Env: `SEARCH_SERVICE_URL`, `SEARCH_SERVICE_TOKEN`, pointing at the search service, a read-only
  layer over Qdrant that runs in the cluster outside this repository (ask an infra owner for access).
  When the URL is unset, the procedure fails with a clear error.

## How a search runs

Code: `src/server/services/semantic-image-search.service.ts` decides the viewer's filters, builds
the Qdrant filter, asks the search service for ranked ids and hydrates them. The site only ever
asks for ids, never payload.

1. **Query.** Text goes to the service's `POST /v1/search` (collection `images`). The service
   corrects its spelling (SymSpell) and embeds it with `wemm-2b`; when it corrected the text, the
   page shows "Showing results for …". "More like this" goes through the service's read-only Qdrant
   pass-through (`/qdrant/collections/images/points/query`) by point id, with `rescore` and
   `oversampling: 2`, and makes no embedding call.
2. **Candidates.** The Qdrant filter the site sends covers:
   - the viewer's browsing level (`nsfwLevel`)
   - the chosen tags: every chosen tag must be present
   - excluded tags
   - base models
   - media type (the page offers images only until videos are embedded)
   - the chosen users, by username (none found returns nothing)
   - a posted-date range on `sortAt`
   - the viewer's hidden and blocked users
   - never an NSFW image on a base model whose license forbids NSFW, as on the image search index
3. **Hydration.** The candidate ids go through `getAllImages` with `ids`, the same database path
   the image feed uses. The page is returned in Qdrant's order. Qdrant's payload can lag Postgres,
   so it only proposes candidates: whatever hydration drops never reaches the page.
4. **Backfill.** When hydration drops candidates, more are fetched: up to 3 rounds of
   `3 × missing` candidates each, at most 100 ids per round. The cursor is an offset into the
   ranking, capped at 2000.

Tags that cannot be browsed are dropped from the tag filter, as on the image feed, and a filter
made only of such tags returns nothing. "More like this" refuses an image the viewer cannot see.
A signed-out visitor gets the site defaults for hidden tags and browsing add-ons.
The search applies the viewer's hidden images, tags and users, and the browsing-settings add-ons
(person-of-interest, minor and excluded tags), on the server. The image feed applies those in the
browser.

Moderators get the image feed's moderator view, which is wider than a regular viewer's.

## On /search/images, the header and the quick search

The original image search surfaces answer from the same search. `withSemanticImageSearch`
(`src/components/Search/semanticImageSearchClient.ts`) wraps their InstantSearch clients: a request
for the images index becomes a `semanticImageSearch.search` call, answered in Meilisearch's response
shape, and every other index passes through to Meilisearch.

- The browsing level comes from the `nsfwLevel=…` clauses `BrowsingLevelFilter` writes; base model,
  tags (by name), users (by username) and the posted-date range come from the widgets' refinements.
- InstantSearch pages by number, the search by an offset into its ranking, so the client remembers
  the offset each page starts at.
- There are no facet counts in a vector search. The widgets get choices only: every base model, and
  the tags and users already chosen; typing in the Tags or Users picker searches `tag.getAll` and
  `user.getAll`.
- An empty query shows a prompt instead of results, and a request refined by a filter the index
  cannot apply yet (aspect ratio, tools, techniques) returns nothing. The sidebar offers browsing
  level, posted date, users, tags and base model.
- `imageSearch` gates these surfaces too: without it, and without `feedSearch`, the Images entry
  is not offered and /search/images redirects to /search/models. With `feedSearch` on,
  /search/images redirects to /images instead (below).

## Search v3: searching the images feed

`feedSearch` (Flipt key `search-v3-feed`) switches a viewer from the search pages to searching the
feed they are on. It works on its own, without `imageSearch`, so rolling it out in Flipt moves
people from the old search to the new one; off is the old search. Flipt keys every signed-out
visitor as one entity, so a percentage rollout splits signed-in users only.

With it on:

- On /images the header bar filters the feed on Enter or blur (`?query=`), answered by
  `semanticImageSearch.search`. The feed's filters the index can apply carry into the search; the
  rest are greyed under "Not available while searching". Sort is locked to Best match, unless
  `imageSearchNewestSort` (Flipt key `image-search-newest-sort`, dark) is on: then the sort menu
  also offers Newest matches, the best matches by date (`?searchSort=newest`), sent as `sort: 'newest'`.
- /search/images redirects to /images with its query, user, base model and tags.
- A refused query (illegal, profane on green, real people with POI off, blocked words) is never
  searched, typed or arriving by link; the feed shows the search page's warning instead.
- A failed search falls back to the plain feed with a retry banner.

Code: `src/components/Image/Infinite/` (`image-feed-search.ts`, `useImageFeedSearch.ts`,
`ImageFeedSearchSummary.tsx`), `src/components/AutocompleteSearch/useFeedSearchSync.ts` and
`src/components/Search/search-refusal.ts`.

## Feedback and logging

- Every first page is logged to ClickHouse through `Tracker.search`, with index `images_semantic`.
  The filters JSON carries the filters, `resultCount` and `latencyMs`.
- Thumbs up or down plus an optional comment are written to the `Feedback` table, area
  `semantic-image-search`. They appear in the moderator feedback queue. Like every feedback area,
  it needs its own Flipt flag, `feedback-area-semantic-image-search`, turned on.
