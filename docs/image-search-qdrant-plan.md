# Plan: image search on the Qdrant index

Goal: `/search/images` answers from the Qdrant image index (`images_semantic`) for everyone, with
every filter the retired Meilisearch image search offered. The vector index is described in
[features/semantic-image-search.md](features/semantic-image-search.md), and the existing mod-only
test page in [features/semantic-image-search-page.md](features/semantic-image-search-page.md).

Decisions taken:

- **A search service in front of Qdrant**, run in the cluster outside this repository: a thin
  read-only layer with SymSpell spelling correction and query embedding, shared by image and model
  search. The site asks it for ranked ids only and always loads them through its own fetch path,
  because the index updates asynchronously and may still hold removed images. Viewer policy
  (browsing level, hidden users, tags and images, the base-model license rule) is decided by the
  site and sent as a Qdrant filter.

- **Surface:** `/search/images` and the Images entry (header, quick search, `/search` tabs) come
  back and render semantic results. `/search/semantic` redirects to `/search/images`, keeping its
  query, so existing "more like this" links still work.
- **Signed-out visitors can search**, rate-limited by IP. Signed-in users keep their user bucket.
- **Rollout:** a Flipt flag `semantic-image-search` for devs, mods and testers first, then public.
- **Sort:** non-relevance sorts re-rank relevant candidates in our service (see Sort).
- **Video:** the media-type filter hides the Video chip until videos are embedded.

## Filter parity

What the Meili page offered, and how each filter maps to Qdrant:

| Filter                                            | Qdrant                     | Work                                                     |
| ------------------------------------------------- | -------------------------- | -------------------------------------------------------- |
| Browsing level                                    | `nsfwLevel`                | done                                                     |
| POI / minor exclusion (browsing-settings add-ons) | applied at hydration       | done                                                     |
| NSFW images on restricted base models             | `nsfwLevel` + `baseModels` | add to `buildCandidateFilter`                            |
| Media type                                        | `type`                     | done; audio excluded, Video hidden until embedded        |
| Tags (all must match)                             | `tagIds`                   | done; picker by name already exists                      |
| Base model                                        | `baseModels`               | done; reuse `renderBaseModelOption`                      |
| Users                                             | `userId`                   | new input `userIds` + a username picker                  |
| Creation date range                               | `sortAt` (datetime index)  | new input `sortAt` range; see note                       |
| Aspect ratio                                      | missing                    | payload `aspectRatio` (keyword) from width/height        |
| Tools                                             | missing                    | payload `toolIds` (integer[]) from `ImageTool`           |
| Techniques                                        | missing                    | payload `techniqueIds` (integer[]) from `ImageTechnique` |

Date range: `sortAt` is the field the index carries. It equals the publish time for published
images, which is what the Meili `createdAtUnix` facet showed in practice. Label the filter
"Posted" rather than adding `createdAt` to the payload.

### Filters that need new payload fields

Aspect ratio, tools and techniques can't be filtered after the fact at hydration: hydration only
drops candidates, and with at most 3 refill rounds and a 2000-candidate cap a selective filter
would empty the page. They belong in the Qdrant payload.

1. `apps/event-engine/src/vector-sync/source.ts`: read `toolIds` and `techniqueIds` (one
   `array_agg` query per table, as for `tagIds`), and derive `aspectRatio` from `Image.width` and
   `Image.height`, using the same buckets as the Meili index (`Square`, `Landscape`, `Portrait`,
   `Unknown`).
2. `qdrant.ts`: add the three payload indexes (integer lookup only for the id arrays, keyword
   for `aspectRatio`, all on disk). `bootstrap` creates missing indexes on an existing
   collection.
3. Keeping them fresh: width and height are on the Image row (in CDC with
   `CDC_IMAGE_ENABLED`). Tool and technique rows are written with the post, before the scan
   finishes, so they are usually present when the image becomes eligible. Edits made later
   need `ImageTool` and `ImageTechnique` in the consumer's topics: check whether the connector
   already streams them, and if not add them the same way `TagsOnImageNew` is consumed.
4. Filling existing points: a payload pass, with no re-embedding. The backfill skips existing
   points but rewrites their payload, so a run with the new source fields fills them in.
   Schedule it inside the write window with `--max-rate`, as for the original backfill.

Until that pass completes, these three filters return only the points rewritten so far, so they
stay hidden behind a separate switch until the pass finishes.

## Sort

Meili offered Relevancy, Most Reactions, Most Discussed, Most Collected, Most Buzz and Newest
(Newest hidden for viewers who can't see NSFW). The payload carries no metrics, and the
metrics change constantly, so copying them into Qdrant would mean a constant stream of payload
writes.

Decided: **Relevancy** is the Qdrant order. The other sorts **re-rank the top relevant
candidates** (the first N above a similarity floor, N about 500) by the metric read at hydration,
which already returns stats. That gives "the most-reacted images that match this query", which
is what a user expects from a search, not the most-reacted images site-wide. Newest can use
Qdrant's `order_by: sortAt` with the same similarity floor. N and the floor are tuned against
tester feedback.

## Server changes

Done: the site's `semantic-image-search.service.ts` calls the search service (`/v1/search` for
text, its Qdrant pass-through for "more like this") instead of Qdrant and the orchestrator.

- `semantic-image-search.router.ts`: `search` moves from `protectedProcedure` to a public
  procedure with the same flag check. Rate limits: keep 60/min for signed-in users and add a
  lower IP bucket for signed-out visitors. `feedback` stays signed-in.
- `semantic-image-search.service.ts`: the user is optional. Signed out means the site's default
  hidden tags and browsing add-ons. Hydration through `getAllImages` already supports an anonymous
  viewer.
- Query-embedding cost: every new text query is one orchestrator embedding call. The site keeps no
  query-embedding cache; any caching of repeats happens in the search service or the orchestrator
  (confirm with their owners). The service exports `search_request_duration_seconds` and
  `search_query_vector_cache_total`; check p95 and the hit rate before going public.
- Schema: `userIds`, `sortAt` range, `aspectRatios`, `toolIds`, `techniqueIds`, `sort`.

## Front end

- `/search/images` renders on `SearchLayout` and `SearchHeader`, so the header, tabs and quick
  search behave as on the other indexes, with the filters in the left sidebar. The data comes from
  the tRPC query, not InstantSearch: give `SearchLayout` a mode without a search client, as
  `maintenance` already does.
- Filters keep the Meili page's URL params (`tags`, `users`, `baseModel`, `aspectRatio`, `tools`,
  `techniques`, `createdAt`, `sortBy`), so old links keep working. Names resolve to ids on the
  server: tags by name, users by username, tools and techniques by name.
- Keep "more like this" (`imageId`) and the thumbs feedback, while the page is behind the tester flag.
- Feature flags: `imageSearch` gates the Images entry and the search itself; it follows the new
  Flipt flag. (The old Meilisearch maintenance paths and the separate `imageSearchEntry` flag are
  gone; the retired `images_v6` indexer is removed in a follow-up.)

## Order of work

1. Server: public procedure, optional viewer, restricted-base-model filter, users and date range.
   The site calling the search service. (Done.)
2. Page: `/search/images`, the header and the quick search on the semantic search, with the filters
   already covered. (Done, for moderators.) Then the tester flag.
3. Event engine: the three payload fields and indexes, then the payload pass. The site's filter
   builder gains the matching clauses.
4. Aspect ratio, tools and techniques filters on once the pass is complete.
5. Sorts by re-ranking; tune N and the similarity floor from tester feedback. Re-ranking needs the
   metrics, which the site has at hydration, so it runs on the site over the service's ids.
6. Set `SEARCH_SERVICE_URL` / `SEARCH_SERVICE_TOKEN` for the site (ask an infra owner).
7. Open the flag to everyone.

## Latency (measured from a developer machine, 2026-11-05)

- Warm: 0.15 to 0.8 s at the service for any filter shape. A new query text adds one embedding
  call, 1.3 to 4.5 s, then the cached vector serves it in about 0.2 s.
- Cold: the first query of a filter shape Qdrant has not served recently can take 3 to 10 s, because
  vectors, the HNSW graph and the payload indexes are on disk. The base-model license clause (a nested
  `must_not` over NSFW levels and 11 base models) roughly triples that first cost (about 10 s against
  3.8 s without it). The site waits 20 s for the search service, for the tester phase.
- To fix before going public: store the license rule as one boolean payload field at index time
  (`nsfwRestrictedBaseModel`), so the clause becomes a single indexed match; and decide with the index
  owners whether the payload indexes or the graph can sit in RAM.
- The site adds hydration through `getAllImages`; from outside the cluster that dominated (5 to 10 s), so
  measure it from inside the cluster before drawing conclusions.

## Open questions

- Does Hat Turf on search results need anything from this page beyond the image cards'
  decorations (`useSearchEventDecorations`)?
