# Auto-resolve `useIndex` server-side

## Problem

`image.getInfinite` chose between the Meilisearch index (`getAllImagesIndex`, scalable) and
the raw Postgres feed (`getAllImages`, expensive) based on a **client-controlled** `useIndex`
flag. Two issues:

1. **Abuse surface.** Anyone could send `useIndex: false` with broad filters to force the
   un-indexed Postgres path — the exact load the index exists to absorb.
2. **Accidental rate-limit trips.** The Cloudflare rate-limit rule keyed on `useIndex: true` in
   the request params, so legit index-feed traffic counted against it; opening/refreshing several
   post pages could trip it.

## Fix

Remove `useIndex` from the public input entirely (schema + every frontend callsite). The server
auto-resolves the path from the query params:

```ts
// src/server/controllers/image.controller.ts — getInfiniteImagesHandler
const requiresDbPath =
  !!input.postId ||
  !!input.postIds?.length ||
  !!input.collectionId ||
  !!input.reactions?.length ||
  !!input.imageId ||
  (!!input.modelId && !input.modelVersionId) ||
  (!!input.prioritizedUserIds?.length && (!!input.modelId || !!input.modelVersionId));

// BitDex routes through the index too, so it's gated on the same predicate.
const bitdexMode = requiresDbPath ? null : await getFliptVariant(/* ... */);
const useBitdex = bitdexMode === 'shadow' || bitdexMode === 'primary';
const useIndex = useBitdex || (features.imageIndexFeed && !requiresDbPath);
```

- **Broad feed queries** (no DB-only param) always go through the index. A client can no longer
  force the DB path on them — abuse vector closed.
- **DB-only params** stay on Postgres because the index physically can't serve them. This single
  predicate now gates **both** the index decision and BitDex eligibility (BitDex also routes through
  the index, so it can't serve these either — previously `skipBitdex` omitted `imageId`/bare
  `modelId`, which could route them to a BitDex index that silently ignored the filter):
  - **Correctness-critical** (wrong results if ignored): `postId`/`postIds`, `collectionId`,
    `reactions`, `imageId`, and a bare `modelId` (the index keys on `modelVersionId`/`postedToId`,
    not `modelId`). Matches the `useLegacyMethod` logic in `/api/v1/images`.
  - **Ordering-only**: `prioritizedUserIds` forces the DB **only when model-scoped** (its sole legit
    use — the model showcase carousel always pairs it with `modelVersionId`). Sent alone it can't be
    used as a broad-feed DB escape hatch; it just degrades to index ordering.
- Removing the param also makes the Cloudflare rule (which matched `useIndex: true`) dormant, so
  post viewing stops tripping it.

`getImagesAsPostsInfiniteHandler` and `/api/v1/images` already resolved the path server-side and
never read the client flag, so they're unchanged.

## Why this over per-domain endpoints

The earlier draft (PR #2444, closed) added dedicated per-domain endpoints (`post.getImages`, etc.).
Auto-resolution achieves the same safety with a much smaller, centralized change — no new endpoints
or client hooks — and additionally fixes a latent inconsistency where the image-detail carousel
(DB) could disagree with the index-backed feed it was opened from.

## Behavior notes

- When `imageIndexFeed` is off (flag not rolled out), resolution falls back to BitDex-only exactly
  as before.
- The only intentional routing change: broad queries that previously omitted `useIndex` and hit the
  DB now hit the index. No legit callsite depended on the DB path for a broad query — the
  `useIndex: true` callsites already wanted the index, and the DB-only callsites carry a DB-only
  param.
- `images_feed_without_index_total` is retained (now counts the auto-resolved DB path) to confirm
  the broad-query DB path goes to ~0 post-rollout.
