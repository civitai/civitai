# @civitai/search

The contract of the search service (`apps/search`) and a server-side client for it.

- `images.ts`: zod schemas for `POST /images/search`: a text query or "more like this", typed
  filter clauses, offset paging. The result is **ranked ids only**.
- `client.ts`: `createSearchClient({ endpoint, token })`, with `images.search(input)`. Failures
  throw `SearchServiceError` with a `code` (`invalid`, `unauthorized`, `not-found`, `not-ready`,
  `upstream`, `unavailable`).

## Why ids only

The vector index is updated asynchronously from Postgres. An image that was removed, blocked or
re-rated a moment ago can still be a result. The caller loads the ids through its own fetch path,
which applies the current visibility rules and drops whatever should no longer be shown.

## Viewer policy belongs to the caller

The filter carries decided values: allowed NSFW levels, excluded users and images, the base-model
licence rule. The service applies them and derives none. `nsfwLevels` is required and non-empty, so
a caller that forgets the browsing level gets a 400 rather than unfiltered results.

Ships raw TypeScript, like the other `@civitai/*` packages.
