# Search replacement: OpenSearch back end, rebuilt front end

Site search (models, users, articles, collections, bounties, tools, comics) moves off Meilisearch
onto OpenSearch, and the search UI is rebuilt rather than ported. Meilisearch keeps serving the
current UI until the new one ships behind a flag; then we cut over and decommission it.

Image search is not part of this: it is coming back as semantic search
(`docs/features/semantic-image-search.md`).

## Why the front end changes too

- The current UI writes Meilisearch's dialect in two places: filter strings in Meili grammar
  (browsing level, autocomplete `#tag` / `@user` tokens), and sorts encoded as virtual index names
  (`models_v9:metrics.downloadCount:desc`). No other engine reads either, and an index name cannot
  carry a colon in OpenSearch.
- `/api/search` already keeps the engine and its key behind the server, but it speaks the
  Meilisearch protocol so the existing InstantSearch UI could keep working. It is the path we keep
  until cutover, not the new API.

## The contract

`src/server/schema/search.schema.ts` is what the new UI and the server consumers send: an index,
text, typed filters per index, a named sort, facets, a page size and a cursor. There is no field in
it for engine syntax, and none for who may see what.

`src/server/search/search-scope.ts` turns a query plus the viewer into engine-neutral clauses
(`eq`, `in`, `range`, `not`, `or`), which each engine adapter compiles. The viewer's scope is
always ANDed on:

| Rule                                                                                                                                         | Applies to                                      | Moderators   |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------ |
| Browsing level: the viewer's choice narrowed to the site's cap; public level if none is given; nothing if the choice is wholly above the cap | models, articles, collections, bounties, comics | still capped |
| Not POI, unless the viewer owns the model                                                                                                    | models                                          | lifted       |
| Not private, unless the viewer owns the model                                                                                                | models                                          | lifted       |

`src/server/search/__tests__/search-scope.test.ts` holds the reference semantics of the clauses
over fixture documents, and asserts what must be **absent** from results, not merely that results
come back. Each engine adapter must agree with it on the same fixtures.

`sortFromLegacySortBy` maps every sort the current UI can put in a URL to its new named sort, so
old bookmarked and indexed search URLs keep working after cutover. The old bounties "Newest" option
carried no direction and sorted oldest first; it maps to `newest`.

## What each index serves today

| Index       | Searchable                                                                                             | Filters the UI uses                                                                                   | Sorts                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| models      | name, username, hashes, trigger words (the civitai.com name is declared but not yet on the live index) | type, base model, category, checkpoint type, tags, username, last version date, hashes (autocomplete) | relevance, likes, downloads, favorites, comments, collected, tips, newest |
| articles    | title, content, tags, username                                                                         | tags, username                                                                                        | relevance, favorites, views, comments, tips, newest                       |
| users       | username                                                                                               | —                                                                                                     | relevance, followers, likes, uploads, newest                              |
| collections | name                                                                                                   | type, username                                                                                        | relevance, followers, items, newest                                       |
| bounties    | name, username                                                                                         | type, base model, tags, username                                                                      | relevance, buzz, entries, favorites, newest                               |
| tools       | name, domain, company, description                                                                     | type, company                                                                                         | relevance, name, created                                                  |
| comics      | name, description, username                                                                            | genre                                                                                                 | relevance, created, followers, chapters                                   |

Model relevance today is mostly popularity: Meilisearch ranks by which attribute matched, then
official models, then likes, then word matches, and only allows a typo in words of 12+ characters.
That is the bar the OpenSearch relevance work is measured against.

Server-side consumers of the models index (`model-search`, `resource-select`,
`resource-intent-matcher`, `model.service`) back the generator's resource picker, so they move to
the new API behind the same flag and are compared before cutover.

## Rebuilding an index

A Meilisearch reset reads every model again and has no checkpoint: if it fails partway, it starts
over, and the site keeps serving the old index only because the reset writes to a swap index.
OpenSearch builds work differently (`src/server/search/opensearch/index-build.ts`):

- **Each build is a new concrete index behind an alias** (`models` → `models_20261103153000`). The
  serving index is never written by a build, the alias moves in one atomic call when the build is
  complete, and the previous build is kept, so `rollbackAlias` undoes a bad build in seconds without
  touching the database.
- **Builds resume.** Ids are scanned in order with a keyset query, batches run concurrently, and a
  checkpoint records the highest id below which every batch is written. A build that dies continues
  from there.
- **Rows that change during the build are caught up** before the swap, including rows that left the
  index.
- **Write settings are tuned for loading** (no refresh, no replicas) and restored before the swap.
  Documents the engine refuses under load are retried; a document it rejects stops the build before
  the swap.

Documents come from the same pull and transform as the Meilisearch models index
(`createModelsIndexSource`), so the two indexes cannot drift while both run. Building one batch is
dominated by a dozen sequential queries rather than by any slow one, so throughput comes from
running batches concurrently: a test build of 10,000 models went from 54 to 283 documents a second
between 1 and 16 concurrent batches.

## Order of work

1. Contract and inventory (this document).
2. A local OpenSearch spike over the models index: relevance, typo tolerance, facets and index size
   compared with Meilisearch. Confirms the engine.
3. OpenSearch for dev and prod.
4. Dual-write every served index to both engines from the existing document builders; backfill;
   check counts match.
5. The new search API on OpenSearch, implementing the contract and the per-site hit shaping
   `/api/search` does today.
6. A relevance comparison on real queries; tune.
7. Move the server consumers.
8. Design and build the new UI behind a flag, with old URLs redirected.
9. Ramp the flag, then remove Meilisearch, `/api/search`, the InstantSearch dependencies and the
   search env vars.
