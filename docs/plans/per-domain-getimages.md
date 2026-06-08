# Per-domain `getImages` endpoints — stop client-controlled `useIndex` from exposing the un-indexed DB feed

## Problem

`image.getInfinite` and `image.getImagesAsPostsInfinite` are both `heavyProcedure` (per-pod
bulkhead + the heavy edge limits). Their input carries a **client-controlled** `useIndex` flag
(`src/server/schema/image.schema.ts:346`). The server picks the data path off that flag
(`src/server/controllers/image.controller.ts:308`):

- `useIndex` truthy (or BitDex active) → `getAllImagesIndex` (Meilisearch — the scalable path)
- falsy / unset → `getAllImages` (raw Postgres feed path — the expensive one)

Two consequences:

1. **Abuse surface.** It is just an API request. Anyone can call `image.getInfinite` with
   `useIndex: false` and arbitrary filters to force the un-indexed Postgres path — exactly the
   load the bulkhead and edge limits exist to shed. There is no Meilisearch backing to absorb it.
2. **Accidental self-DoS for legit users.** Post viewing legitimately needs the DB path (postId
   lookups aren't well served by the index), so it rides the same heavily-limited feed procedure.
   Opening ~10 post pages in a minute — or a few refreshes / client retries while something is
   slow — trips the limit by accident.

**Root cause: the index-vs-DB decision is a client input, not a server policy.**

## Goal / principle

> No public endpoint exposes the un-indexed `getAllImages` path with client-controlled filters.
> The generic feed is **always** index-backed. The handful of queries that genuinely need the DB
> path (narrow, cheap, or owner-scoped) each get a **dedicated, server-pinned endpoint** that sets
> its own filters and is not on the heavy feed surface.

`useIndex` stops being part of any public input contract. The server decides per endpoint.

## Why the index can't just serve everything

`getAllImagesIndex` cannot serve these filters today (the `skipBitdex` list,
`image.controller.ts:291`):

- `postId` / `postIds` — specific-post lookups (covered index in PG, ~2ms; unique cache keys hurt index cache hit rate)
- `collectionId` — needs relational joins through `CollectionItem`
- `reactions` — per-user reaction data isn't in the index (needs `ImageReaction` subquery)
- `prioritizedUserIds` — index has no user-prioritization yet (TODO in `getAllImagesIndex`)

Every caller that depends on one of these must move off the generic feed procedure **before** we
can lock the generic procedure to index-only.

## Design

### New per-domain endpoints (server-pinned to the DB path)

Each wraps the existing `getAllImages` / `getImagesAsPostsInfinite` service fn under the covers,
pins its own filter set server-side, and lives on a normal `publicProcedure` (cheap queries — no
heavy bulkhead). Per Justin: don't worry about rate-limit tiers for these.

| Endpoint                                                               | Pinned filter                           | Replaces (callsite)                                                   |
| ---------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| `post.getImages`                                                       | `postId` (from input)                   | `PostDetail.tsx:120`, image detail when `postId`                      |
| `collection.getImages` (or keep on collection router)                  | `collectionId`                          | `collections/[collectionId]/review.tsx` (via `ImagesAsPostsInfinite`) |
| reacted-images endpoint (`user.getReactedImages` / `image.getReacted`) | `reactions` + `userId=self`             | `UserMediaInfinite.tsx:169` "My Reactions" tab                        |
| model-showcase endpoint (or extend `getImagesForModelVersion`)         | `modelVersionId` + `prioritizedUserIds` | `ModelCarousel.tsx:58`                                                |

Naming TBD — see open questions. `@justin:` \*

### Lock the generic feed to index-only

Once the table above is migrated:

- Drop `useIndex` from `getInfiniteImagesSchema` (public contract).
- In `getInfiniteImagesHandler` / `getImagesAsPostsInfiniteHandler`, force the index path
  (`useIndex = true` server-side; BitDex logic unchanged).
- Reject (or strip) the DB-only filters — `postId`, `collectionId`, `reactions`,
  `prioritizedUserIds` — on the generic feed input so they can't be smuggled in to force a fallback.
- Keep the `imagesFeedWithoutIndexCounter` metric to confirm the DB path goes to ~0 on the generic
  endpoint post-rollout.

## Callsite audit

`useQueryImages` / `image.getInfinite` / `image.getImagesAsPostsInfinite` consumers:

### Index-safe — leave on generic feed (already `useIndex` or index-servable filters)

- `pages/images/index.tsx:28` — browse feed (`useIndex`)
- `pages/videos/index.tsx:31` — browse feed (`useIndex`)
- `pages/tools/[slug].tsx:91` — tool feed (`useIndex`)
- `components/Profile/Sections/MyImagesSection.tsx:46` — `useIndex: true`
- `components/ResourceReview/ResourceReviewCarousel.tsx:40` — `useIndex: true`
- `components/Image/DetailV2/ImageRemixesDetails.tsx:18` — `useIndex: true`
- `components/Image/Infinite/UserMediaInfinite.tsx:169` — `useIndex={!viewingReactions}` (the
  non-reactions branch stays here; the reactions branch moves — see below)
- generic `ImagesInfinite` browse (store filters: sort/period/types/tags/baseModels) — index-servable

### DB-needed — must migrate to a dedicated endpoint

- `components/Post/Detail/PostDetail.tsx:120` — `{ postId }` → **`post.getImages`**
- `pages/collections/[collectionId]/review.tsx` (via `ImagesAsPostsInfinite`) — `collectionId` → **`collection.getImages`**
- `components/Image/Infinite/UserMediaInfinite.tsx` reactions tab — `reactions` + self `userId` → **reacted-images endpoint**
- `components/Model/ModelCarousel/ModelCarousel.tsx:58` — `modelVersionId` + `prioritizedUserIds` → **model-showcase endpoint** (or implement `prioritizedUserIds` in `getAllImagesIndex` and keep it on the index)

### Special case — `components/Image/Detail/ImageDetailProvider.tsx:85`

The image detail viewer **replays the source feed's filters** to drive prev/next navigation
(`{ ...filters, userId, postId, browsingLevel }`). Its query shape is whatever feed the user came
from — could be index-servable (modelId/username/tags) **or** DB-only (postId/collectionId/reactions).

After the split it must **route to the matching endpoint by filter shape**: postId → `post.getImages`,
collectionId → `collection.getImages`, reactions → reacted endpoint, else → generic index feed. This
is the most involved migration; the carousel must paginate consistently with the originating feed.
`@justin:` \* worth confirming we still want full prev/next continuity in every entry context, or if
some (e.g. opening a single post image) can fall back to post-scoped pagination only.

### REST `/api/v1/images` (`src/pages/api/v1/images/index.ts:196`)

Public REST handler has its own `useIndex` / `getAllImages` branch. Same abuse surface as the tRPC
feed. Decide: force index-only here too, or pin the DB path to a whitelist of cheap filters
(imageId/modelId lookups it already special-cases at `:170`). `@justin:` \*

## Phased rollout

1. **Phase 1 — `post.getImages` + migrate post viewing.** Stand up `post.getImages`, point
   `PostDetail` (and the `postId` branch of `ImageDetailProvider`) at it, update the SSG prefetch in
   `pages/posts/[postId]/[[...postSlug]].tsx:48`. Post viewing leaves the heavy surface immediately.
2. **Phase 2 — remaining DB-only callsites.** `collection.getImages`, reacted-images, model-showcase.
3. **Phase 3 — lock down.** Drop `useIndex` from the public schema, force index on the generic feed
   procedures + REST handler, reject DB-only filters. Watch `imagesFeedWithoutIndexCounter`.

Phases 1 and 2 are independently shippable and non-breaking (additive endpoints). Phase 3 is the
behavior change and the security win.

## Open questions for `@justin:` \*

1. Endpoint names: `post.getImages`, `collection.getImages`, `user.getReactedImages`,
   model-showcase — happy with these, or a different home (e.g. all under `image.*` namespaced)? @justin: These are good
2. Model showcase: dedicated DB endpoint, or invest in `prioritizedUserIds` support inside
   `getAllImagesIndex` so the carousel stays index-backed? @justin: If these are db backed now, let's keep them that way.
3. REST `/api/v1/images`: force index-only, or keep a cheap-filter whitelist for the DB path? @justin: Force index-only, throw on params that are not supported without index. (please list them for me below so I can consider)

   `@ai:` Params that force the legacy/DB path on `/api/v1/images` today (i.e. **not** index-servable):

   - `imageId` — single-image lookup (`:187` `useLegacyMethod`)
   - `modelId` **without** `modelVersionId` — model gallery (`:187`; engagement sorts already collapse to newest-by-id, `image.service.ts:1414-1422`)
   - `postId` / `postIds` — post images (`skipBitdex`)
   - `collectionId` — `CollectionItem` join (`skipBitdex`)
   - `reactions` — needs `ImageReaction` subquery + auth (`skipBitdex`)
   - `prioritizedUserIds` — no user-prioritization in index yet (`skipBitdex`)

   **Caution before we hard-throw here:** unlike the internal tRPC feed, `/api/v1/images` is the
   **public documented API**. `imageId`, `postId`, and `modelId` are legitimate, advertised
   lookups that external integrations rely on — and they're _narrow, cheap covered-index queries_,
   not the broad full-feed scan that is the actual abuse vector. Throwing on them would break real
   integrations for no load benefit. Recommend: **whitelist the narrow lookups** (`imageId`,
   `postId`/`postIds`, `modelId`+`modelVersionId`) onto the DB path, and force index-only for
   everything broad. Throw only when a _broad_ feed query carries a DB-forcing param it can't honor.
   This is a Phase 3 / REST decision — flagging now, not touching it in Phase 1. `@ai:` \*

4. `ImageDetailProvider`: full prev/next continuity from every source feed, or acceptable to scope
   pagination in some entry contexts? @justin: Not sure I understand. Why does this change?

   `@ai:` It only changes **at Phase 3**, and only _because_ of the lockdown — not in Phase 1.
   Today the detail viewer reuses `image.getInfinite` with the **same filters as the feed you
   clicked in from** so its prev/next carousel paginates through that exact set. While the DB path
   stays available (Phases 1-2) nothing breaks. Once Phase 3 locks `image.getInfinite` to index-only
   and rejects `postId`/`collectionId`/`reactions`, the viewer's existing call would 400 for those
   source feeds — so at that point it must route to the matching new endpoint by filter shape. My
   question was just: when you open an image _from a post_, is it fine for prev/next to walk only
   that post's images (simple — reuse `post.getImages`), vs. trying to reconstruct the original
   broad feed. Not relevant to Phase 1; I'll re-raise it when we scope Phase 3. `@ai:` \*

5. Scope of this first PR: just Phase 1 (`post.getImages` + post viewing), then iterate? @justin: Yes, start with post, then once reviewed, we'll open another
