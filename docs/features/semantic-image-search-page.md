# Semantic image search: the search page

`/search/semantic` searches images by meaning: a text query, or "more like this" from an image
(an item in the image card menu, shown with the flag). It
reads the vector index described in [semantic-image-search.md](semantic-image-search.md). It is a
test surface for now, shown only to those with the `semanticImageSearch` feature flag.

## Access

- Flag `semanticImageSearch` (Flipt key `semantic-image-search`). Without Flipt it falls back to
  moderators only. Flipt overrides that in both directions, so add moderators to the Flipt rule too.
- The page's `getServerSideProps` and both procedures (`semanticImageSearch.search`, `.feedback`)
  check the same flag, and both procedures require a signed-in user.
- Env: `QDRANT_URL`, `QDRANT_API_KEY`. A read-only key is enough. When the variables are unset,
  the procedure fails with a clear error.

## How a search runs

Code: `src/server/services/semantic-image-search.service.ts`.

1. **Query vector.** The text is trimmed and its whitespace collapsed. Case is kept. It is embedded
   with `wemm-2b` at 256 dimensions through the orchestrator's synchronous `multimodalEmbedding`
   recipe, using the system orchestrator client. The vector is cached in Redis for 7 days, keyed on
   model, dimensions, the index's model revision and profile, and a hash of the text. A response
   whose model revision or profile differs from the one recorded on the collection is refused.
   "More like this" queries by point id and makes no embedding call.
2. **Candidates.** One Qdrant query runs on the `images_semantic` alias (`rescore`,
   `oversampling: 2`). It filters on:
   - the viewer's browsing level (`nsfwLevel`)
   - the chosen tags: every chosen tag must be present
   - excluded tags
   - base models
   - media type
   - the viewer's hidden and blocked users
3. **Hydration.** The candidate ids go through `getAllImages` with `ids`, the same database path
   the image feed uses. The page is returned in Qdrant's order. Qdrant's payload can lag Postgres,
   so it only proposes candidates: whatever hydration drops never reaches the page.
4. **Backfill.** When hydration drops candidates, more are fetched: up to 3 rounds of
   `3 × missing` candidates each, at most 100 ids per round. The cursor is an offset into the
   ranking, capped at 2000.

Tags that cannot be browsed are dropped from the tag filter, as on the image feed, and a filter
made only of such tags returns nothing. "More like this" refuses an image the viewer cannot see.
The search applies the viewer's hidden images, tags and users, and the browsing-settings add-ons
(person-of-interest, minor and excluded tags), on the server. The image feed applies those in the
browser.

Moderators get the image feed's moderator view, which is wider than a regular viewer's.

## Feedback and logging

- Every first page is logged to ClickHouse through `Tracker.search`, with index `images_semantic`.
  The filters JSON carries the filters, `resultCount` and `latencyMs`.
- Thumbs up or down plus an optional comment are written to the `Feedback` table, area
  `semantic-image-search`. They appear in the moderator feedback queue. Like every feedback area,
  it needs its own Flipt flag, `feedback-area-semantic-image-search`, turned on.
