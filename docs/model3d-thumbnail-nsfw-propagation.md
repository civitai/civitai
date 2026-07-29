# Model3D thumbnail → nsfwLevel propagation (handoff)

**Status:** ✅ IMPLEMENTED (2026-07-08). ADD (cron derived-discovery) + REVERT + the queue-fn
removal are in; typecheck green. Additionally, a **gated inline prompt path** was added so
Model3D levels update immediately on scan/mod (not just on the next cron tick), mirroring how
Posts work — see the "PROMPT PATH" section. The "open question" (create-time enqueue) was
moot — already committed. Only the one-time heal SQL remains to run by hand when shipping.
**Date:** 2026-07-08
**Repo:** this one (`C:\work\civitai` — main Next.js app), not the moderator spoke.

---

## TL;DR

A `Model3D`'s `nsfwLevel` is derived entirely from its thumbnail image. We need the
model to be re-derived whenever the thumbnail image's `nsfwLevel` changes (scan
completes, moderator re-rates, block/unblock).

The old mechanism (`queueModel3DForThumbnailImage`) did a **synchronous Model3D lookup
on every image-scan / image-mod event** — flagged as a code smell (extra work on a hot,
high-volume path for a tiny-volume feature).

**The fix:** treat `Model3D.thumbnailImageId` exactly like `Article.coverId` and let it
ride the existing async connected-entity cascade. When an image's level changes the DB
trigger already enqueues `Image/UpdateNsfwLevel`; the cron that drains that queue resolves
connected entities (posts, article covers, collection items, comic panels…) in a batched,
replica-side lookup and recomputes them. Model3D just needs to be **added to that
resolver** — the lookup then lives in the async cron, off the hot path, and no metadata
flag / new trigger / backfill is required.

---

## Background: how image→entity nsfwLevel propagation already works

Two existing patterns, both driven by the image trigger enqueuing `Image/UpdateNsfwLevel`:

1. **`ImageConnection` rows** — Bounty / BountyEntry covers.
2. **Direct cover FK + batched lookup** — `Article.coverId`. This is the relevant one.

The cron job `update-nsfw-levels` (`src/server/jobs/job-queue.ts`, `updateNsfwLevelJob`,
runs every minute):

1. Reads all pending `UpdateNsfwLevel` `JobQueue` rows, grouped by entity type into
   `jobQueueIds` (`jobQueueIds.imageIds`, `jobQueueIds.model3dIds`, …).
2. Calls `getNsfwLevelRelatedEntities(jobQueueIds)` to **derive** connected entities from
   those ids (image → its post/article-cover/collection/comic; post → modelVersion; etc.).
3. For each entity type does `uniq([...jobQueueIds.X, ...relatedEntities.X])` and passes
   the union to `updateNsfwLevels(...)`, which recomputes each entity.

`Article.coverId` is resolved inside `getImageConnectedEntities`
(`src/server/services/nsfwLevels.service.ts`):

```ts
dbRead.article.findMany({ where: { coverId: { in: imageIds } }, select: { id: true } })
// → returned as articleIds
```

**`Model3D.thumbnailImageId` is the exact structural twin of `Article.coverId`** (unique
FK, cover image), so it belongs in the same resolver.

---

## Why it doesn't work today (the actual gap)

The plumbing is ~95% present:

- `src/server/jobs/job-queue.ts:35` already maps `EntityType.Model3D → 'model3dIds'`.
- `updateNsfwLevels(...)` in `nsfwLevels.service.ts` already accepts `model3dIds` and runs
  `updateModel3DNsfwLevels` in the leaf batch (search `model3dIds`, ~line 232/255/266).
- The image trigger already enqueues `Image/UpdateNsfwLevel` on every level change.

Missing pieces:

1. `getImageConnectedEntities` / `getNsfwLevelRelatedEntities` do **not** produce
   `model3dIds` from `imageIds`.
2. `job-queue.ts` uses only the **directly-enqueued** model3ds:
   ```ts
   // ~line 113
   // Model3D rows enqueue directly via JobQueue (no derived discovery yet …)
   const model3dIds = jobQueueIds.model3dIds;
   ```
   The comment "no derived discovery yet" is the whole bug — every other entity type does
   `uniq([...jobQueueIds.X, ...relatedEntities.X])`; Model3D is the lone exception.

---

## Proposed fix

### ADD — wire Model3D into the connected-entity cascade (mirrors `Article.coverId`)

All in `src/server/services/nsfwLevels.service.ts` except step 3.

**1. `getImageConnectedEntities`** — add the batched thumbnail lookup to the `Promise.all`
and return `model3dIds`:

```ts
const [images, connections, articles, collectionItems, model3ds] = await Promise.all([
  // …existing four…
  dbRead.model3D.findMany({
    where: { thumbnailImageId: { in: imageIds } },
    select: { id: true },
  }),
]);
// …
return {
  // …existing…
  model3dIds: model3ds.map((x) => x.id),
};
```

**2. `getNsfwLevelRelatedEntities`** — thread `model3dIds` through the accumulator, the
`mergeRelated` Partial type + body, and the final return:

```ts
let model3dIds: number[] = [];
// in mergeRelated's param type: model3dIds?: number[];
// in mergeRelated body:
if (data.model3dIds) model3dIds = uniq(model3dIds.concat(data.model3dIds));
// in the return object:
model3dIds,
```

Model3D is a leaf (its level depends on nothing downstream), so there is **no**
`getModel3DConnectedEntities` and no need to add `model3dIds` to the `source` input — we
only ever *derive* model3ds from images.

**3. `src/server/jobs/job-queue.ts` (~line 113)** — union like every other type, drop the
stale comment:

```ts
const model3dIds = uniq([...jobQueueIds.model3dIds, ...relatedEntities.model3dIds]);
```

(`relatedEntities.model3dIds` exists once step 2 lands.)

### REVERT — the abandoned first attempt (currently uncommitted in this tree)

4. `packages/civitai-db-schema/prisma/programmability/nsfw_level_update_triggers.sql`:
   revert to origin/main. Removes **both** the new `update_model3d_thumbnail` trigger and
   the `NEW.metadata->>'model3dId'` read added to `update_image_nsfw_level`. Quickest:
   `git checkout -- packages/civitai-db-schema/prisma/programmability/nsfw_level_update_triggers.sql`
5. Delete the backfill migration dir:
   `prisma/migrations/20260708130000_model3d_thumbnail_metadata_backfill/`.

### KEEP — the queue-fn removal

6. Removal of `queueModel3DForThumbnailImage` + the dead batched
   `queueModel3DsForThumbnailImages` from `nsfwLevels.service.ts` and the now-orphaned
   imports (`enqueueJobs`, `EntityType`, `JobQueueType`). Their per-event `dbWrite` lookup
   was the smell; the cron derived-discovery + the gated inline path below replace them.

### PROMPT PATH — gated inline recompute (added, mirrors the Post pattern)

Derived discovery alone means a Model3D's level only updates on the next cron tick (≤~1 min).
Posts avoid that lag by recomputing **inline** on the scan/mod path (`updatePostNsfwLevel`)
*and* riding the cron as a backstop. Model3D now does the same, with one twist: Posts get
`image.postId` for free off the loaded row, but Model3D needs a `thumbnailImageId → id` lookup.
To keep that lookup off the common path we short-circuit on `postId`: a Model3D thumbnail is a
standalone image (`ingestThumbnailImage` creates it with no post), so any posted image provably
isn't one. The lookup fires only for the post-less minority; the cron backstop heals any rare
replica-lag miss, so a plain `dbRead` is safe.

- New helper `updateModel3DNsfwLevelForThumbnailImage({ imageId, postId })` in
  `nsfwLevels.service.ts`: **the `postId` short-circuit lives inside the helper**, so callers
  invoke it unconditionally as a plain fire-and-forget side effect (no scattered `!postId`
  branches). When there's no post it does a `dbRead` lookup by `thumbnailImageId`, then calls
  `updateModel3DNsfwLevels` directly (a **synchronous** recompute — not a JobQueue enqueue).
- Call sites (each just passes `{ imageId, postId }`, replacing the removed `queueModel3D…`):
  - `src/pages/api/webhooks/image-scan-result.ts` — Scanned + Blocked
  - `src/server/services/image-scan-result.service.ts` — Scanned + Blocked branches
  - `src/server/services/image.service.ts` `updateImageNsfwLevel` — moderator branch (also
    added `postId` to the `findUnique` select)

**Don't generalize the `postId` gate to the comic-panel lookups** next to these calls
(`queueComicsForPanelImage`, `updateComicNsfwLevelsForImage`). Comic panels can reference an
**existing, possibly-posted** image via import mode (`comics.router.ts` "Mode 1: Import from
existing image ID"), so a panel image is *not* guaranteed post-less. Gating those on `!postId`
would silently skip the moderation-visibility refresh for imported posted panels. The gate is
safe for Model3D specifically because thumbnails are always standalone — a Model3D-only
property, not a general rule. (The helper's doc comment says this too.)

**Why not stamp `model3dId` onto the image?** Considered and rejected. It creates a
bidirectional reference (`Model3D.thumbnailImageId` *and* a shadow copy on the image) with no
FK/uniqueness/cascade, goes stale on thumbnail reassignment, and in `Image.metadata`'s case is
also *unsound* (metadata is rewritten wholesale — see next section). The `@unique`
`thumbnailImageId` FK is the single source of truth; the `postId` gate already reduces the
reverse lookup to "occasional," so a denormalized copy buys nothing but a liability.

---

## Why this beats the metadata-flag attempt

The abandoned attempt stamped `Image.metadata.model3dId` at thumbnail assignment (via a
Model3D trigger) and had the image trigger read it (zero lookup). A review found a real
soundness gap: `Image.metadata` is rewritten **wholesale** in several places, so the flag
could be silently and permanently dropped:

- `src/server/services/image-scan-result.service.ts` (~line 735): `"metadata" =
  COALESCE(<modRule.metadata>::jsonb, "metadata")` **replaces** the column when a mod rule
  carries a metadata payload — on the scan path, same UPDATE as the nsfwLevel change.
- `src/server/services/image.service.ts` `updateImageNsfwLevel` (~line 6747) and the
  ingestion-error path (~line 7052): read `metadata` from the **read replica**, spread, and
  write back — fragile under replica lag.

Making `Image.metadata.model3dId` a load-bearing cross-table contract in a codebase that
already overwrites `metadata` wholesale in ≥2 spots was judged worse than the smell it
cured. The connected-entity approach has **no** such invariant — the resolver reads the
live `thumbnailImageId` FK at cron time.

Also note: the replica-lag race the old `queueModel3DForThumbnailImage` fought with
`dbWrite` **disappears** here — the resolver runs in the cron a minute+ after creation,
long after the Model3D row exists and has replicated, so a plain `dbRead` is safe.

---

## Open question — one case derived discovery misses

Derived discovery only fires when the thumbnail image's `nsfwLevel` **changes** (which
enqueues `Image/UpdateNsfwLevel`). If a thumbnail is **already scanned before** it's
assigned to the model, there's no future level change → the model is never discovered →
`Model3D.nsfwLevel` stays 0.

- For the polyGen flow this is a non-issue: `polyGen.handler.ts` ingests a **fresh**
  thumbnail (`ingestThumbnailImage`) that scans *after* the Model3D row exists, so the scan
  produces the level-change event that drives discovery.
- If you want belt-and-suspenders (and to cover any future "assign an existing image as the
  thumbnail" path), add a one-line enqueue at the assignment site
  (`upsertModel3DFromWorkflow` in `src/server/services/model3d.service.ts`, ~line 1389,
  right after `tx.model3D.create`):
  ```ts
  await enqueueJobs([
    { entityId: created.id, entityType: EntityType.Model3D, type: JobQueueType.UpdateNsfwLevel },
  ]);
  ```
  This is literally "do work when the 3D model changes" — the guiding principle for this
  whole change — and it's the only place that ever sets `thumbnailImageId` today.

**Resolved:** no action needed — the create-time enqueue already exists in committed code.
`upsertModel3DFromWorkflow` (`src/server/services/model3d.service.ts`, ~line 1431) already
enqueues an `UpdateNsfwLevel` job for every freshly-created Model3D, guarded by
`result.created`, using the module's existing `enqueueJobs` / `EntityType` / `JobQueueType`
imports. So the "assigned-before-scanned" edge case is covered without any new edit.

---

## Verify / ship

- `pnpm run typecheck` (the abandoned attempt already passed typecheck; re-run after the
  edits).
- One-time heal for existing 3D models whose level drifted (optional, replaces the deleted
  backfill's healing INSERT) — enqueue every Model3D with a thumbnail once:
  ```sql
  INSERT INTO "JobQueue" ("entityId", "entityType", "type")
  SELECT m.id, 'Model3D'::"EntityType", 'UpdateNsfwLevel'::"JobQueueType"
  FROM "Model3D" m WHERE m."thumbnailImageId" IS NOT NULL
  ON CONFLICT DO NOTHING;
  ```
  Run manually (per repo policy migrations are applied by hand, not `prisma migrate
  deploy`). The cron drains it on the next tick.
- Manual test: change a 3D thumbnail image's `nsfwLevel` (retool / SQL), wait for the
  `update-nsfw-levels` cron tick, confirm `Model3D.nsfwLevel` + `Model3DMetric.nsfwLevel`
  update.

## Files touched (final state target)

| File | Action |
|---|---|
| `src/server/services/nsfwLevels.service.ts` | ADD `model3dIds` to `getImageConnectedEntities` + `getNsfwLevelRelatedEntities` (cron); remove the queue fns; ADD `updateModel3DNsfwLevelForThumbnailImage` helper (inline) |
| `src/server/jobs/job-queue.ts` (~L110) | union `jobQueueIds.model3dIds` with `relatedEntities.model3dIds` |
| `.../programmability/nsfw_level_update_triggers.sql` | REVERT to main |
| `prisma/migrations/20260708130000_model3d_thumbnail_metadata_backfill/` | DELETE |
| `image-scan-result.ts`, `image-scan-result.service.ts`, `image.service.ts` | replace removed `queueModel3D…` calls with `!postId`-gated inline `updateModel3DNsfwLevelForThumbnailImage` (image.service.ts also selects `postId`) |
| `src/server/services/model3d.service.ts` | create-time enqueue — already committed, no change |
