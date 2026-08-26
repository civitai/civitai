# Merging models

Status: **design, not built.** Written 2026-08-25 from an investigation into consolidating the
API-only Wan model cards. Nothing here has been implemented.

## Why

API-only ecosystems get a new model card per release (`Wan Video 2.5`, `Wan Video 2.7`,
`Wan 2.7 Image`, …). Each one starts its follower count, reviews and comments from zero, and the
generator's model picker fills with near-duplicate cards. The wanted end state is one card per
media type per family — `Wan Video (api)`, `Wan Image (api)` — that new versions land on.

Getting there needs an operation the codebase does not have: moving a `ModelVersion` to a different
`Model`, and folding the source model's history into the target. Nothing in the repo has ever
updated `ModelVersion.modelId` after creation — `mergeVersions` explicitly refuses cross-model, and
`transferModelOwnership` changes `Model.userId`. There is also no redirect, alias or merge table
anywhere.

## What already works in our favour

**Generation is version-keyed, not model-keyed.** `EcosystemSettings.defaults.model.id` in
`packages/civitai-shared/src/basemodel.constants.ts` looks like a `Model` id but holds a
**`modelVersionId`** — verified against the database. Every ecosystem entry, graph handler and
`getGenerationBaseModel` call resolves through version ids, so moving a version between models
changes nothing in the generator.

Hardcoded Wan **model** ids exist in only two files: `src/shared/constants/ecosystem-seo.constants.ts`
and `src/utils/training.ts` (inside an AIR string). Both need a manual edit on any merge.

**Media type is a base-model property.** `type: 'image' | 'video'` lives on the base-model record, so
it resolves per version. Image and video releases of the same family belong on separate cards — the
constants already model them as separate ecosystems.

## The inventory

Everything below was verified by query, not inferred.

### Postgres

**Plain `UPDATE` — no unique constraint on `modelId`:**
`ModelVersion` (the move itself, plus reindex `index`), `Comment`, `ResourceReview`, `VaultItem`.

`ResourceReview.modelId` is **mandatory and easy to miss**: it is written once at upsert and never
recomputed. Skip it and the model's rating stays credited to the source forever.

**`INSERT … ON CONFLICT DO NOTHING` then `DELETE`** — a unique constraint on `modelId` makes a bulk
`UPDATE` fail, and nothing foreign-keys these tables' ids:

| Table | Key | Collision rule |
|---|---|---|
| `ModelEngagement` | `(userId, modelId)` | see engagement policy below |
| `SavedModel` | `(modelId, userId)` | skip dupes |
| `ModelInterest` | `(userId, modelId)` | skip dupes |
| `TagsOnModelsVote` | `(tagId, modelId, userId)` | skip dupes |
| `TagsOnModels` | `(modelId, tagId)` | skip; `ModelTag` scores recompute from votes |
| `ModelReport` | `(reportId, modelId)` | collides only if one report covers both |
| `ModelBaseModelMetric` | `(modelId, baseModel)` | on collision **sum**, do not drop |
| `ModelMetricDaily` | `(modelId, modelVersionId, type, date)` | never collides — version ids are disjoint |

Carry `createdAt` / `addedById` / `note` / `status` explicitly in the `SELECT` so column defaults do
not rewrite history.

**The rule that decides which of the two applies:** insert+delete iff there is a unique constraint on
`modelId` **and** nothing foreign-keys this table's `id`. Otherwise `UPDATE` in place. It is
checkable by query rather than by memory.

**`CollectionItem` is the exception that bites.** `CollectionItemScore.collectionItemId` references
`CollectionItem(id)` `ON DELETE CASCADE`, so insert-new + delete-old **silently destroys contest
judging scores** — nothing errors, the cascade just takes them. Preferred handling: `UPDATE` in place
for non-colliding rows (preserves the id, so scores stay attached), insert+delete only for the
collisions, and assert `CollectionItemScore` is empty for those or refuse the merge.

**Never insert+delete** — things hang off their `id`: `ResourceReview` (`ResourceReviewReaction`,
`ResourceReviewReport`, `Thread.reviewId`) and `Comment` (`Comment.parentId` self-reference,
`CommentReaction`, `CommentReport`). Neither has a unique constraint on `modelId`, so the rule above
already routes them to `UPDATE`.

**Needs a human — one row per model, no merge semantics exist:**

- `Thread` — `UNIQUE(modelId)`. The hard structural blocker: two root threads cannot coexist, so
  merging means reparenting `CommentV2` rows and rewriting `rootThreadId` / `parentThreadId` chains.
- `ModelDescription` — `PK(modelId)`. Two descriptions, one survives.
- `ModelFlag` — `PK(modelId)`. Moderation state; needs OR-the-flags, not pick-a-winner. Silently
  dropping one side is a safety regression.
- The `Model` row itself — `poi`, `minor`, `nsfw`, `sfwOnly`, `allowCommercialUse`, `licenses`,
  `mode`, `status`, `availability`, `lockedProperties`. `GenerationCoverage`'s predicate reads
  `m.poi` / `m.allowCommercialUse` / `m.type` from the **new** parent, so coverage can silently flip
  at merge time.

**Requeue, never hand-edit — none of these self-heal:**

- `ModelMetric` — its affected-set query keys off `ModelVersionMetric.updatedAt`, which a `modelId`
  change never touches, so **neither** side recomputes. Push both ids onto the metric queue.
- Meilisearch models index — `prepareBatches` selects on `Model.updatedAt`, also untouched. Queue
  `SearchIndexUpdate` for both ids.
- `ModelRank_New`, `Model.nsfwLevel` (`updateModelNsfwLevels`), `Model.lastVersionAt`
  (`updateModelLastVersionAt`).
- Redis: `dataForModelsCache`, `resourceDataCache`, `imageResourcesCache`.

All of this must run **outside** the transaction — see the `no-io-in-transaction` guard.

**Free** — every view: `GenerationCoverage`, `GenerationCoverage2`, `ImageResourceHelper`,
`PostResourceHelper`, `ModelHash`, `ModelTag`, `ModelReportStat`.

### ClickHouse — do not mutate it

Only **7 tables carry `modelId`**. Everything else keys on `modelVersionId` and rides along for free,
because a model merge does not change version ids.

On 6 of those 7, `modelId` is in the **sorting key**, so `ALTER TABLE … UPDATE` is forbidden:
`modelVersionEvents` (2.06B rows), `daily_downloads` (156M), `daily_downloads_unique` (156M),
`modelEngagements` (22.4M), `modelEvents` (6.49M), `resourceReviews` (1.13M), `daily_runs` (363K).
Only `partnerEvents` is mutable.

**It does not matter.** No production metric reads ClickHouse by `modelId`. `ModelMetric` is rebuilt
from `ModelVersionMetric` joined through the *live* `ModelVersion.modelId`; downloads read
`daily_downloads_unique` by `modelVersionId`; generation and earnings read `orchestration.*` by
`modelVersionId`. The one model-keyed read is comment *discovery*, whose counts come from Postgres.

So stale `modelId` in ClickHouse degrades ad-hoc analytics and dashboards only. Resolve it at read
time rather than rewriting history — those event rows are correct as written.

## Engagement policy

Decided 2026-08-25:

- source `Hide` → **dropped**, never inserted on the target. Erring toward showing content the user
  can re-hide beats silently hiding a model they never hid and would have no way to discover.
- source `Mute` → same treatment, same reasoning.
- source `Notify` / `Favorite` → carried, `ON CONFLICT DO NOTHING`.
- **target rows are never modified.** If someone hid the target and followed the source, the target's
  `Hide` stands and the source follow is lost, same as any other dedupe.

⚠️ The `no-pk-addressed-engagement-write` guard bans `.modelEngagement.delete/update/upsert(` and
requires `deleteMany` / `updateMany` with an explicit `type` in the `where` — which is the shape this
policy needs anyway. But that guard states it **cannot see a `where` built in a variable**, and a
manifest-driven merge is exactly that shape. Test the engagement policy directly; do not read a green
guard as coverage.

## Why a tombstone is not enough

A `Model.mergedIntoId` self-reference is worth having for inbound references that cannot be rewritten
— bookmarks, external links, the ids in `ecosystem-seo.constants.ts`, API clients holding a cached
model id. It costs one nullable column and no join, because the model page already loads the row by
id.

**It is not a substitute for moving rows.** A model with zero visible versions is *silently dropped*
at four independent points — `model.service.ts` ejects on no versions, again on no first version,
again on no images, and `collection.service.ts` discards the item during hydration. No broken card is
ever rendered.

That matters most because **"Liked Models" is itself a Bookmark-mode collection**, so it renders
through that same drop path. Leave a like pointing at a tombstone and it vanishes from the only UI
that could remove it, while the `ModelEngagement` and `CollectionItem` rows persist forever. There is
no `HiddenModelsSection` either — account settings covers hidden tags and users only.

Escape hatch for anything stranded: `user.toggleFavorite` and `user.toggleNotifyModel` are
`protectedProcedure`s taking just `{ modelId }`, and `toggleNotifyModel` accepts any engagement type
including `Hide`, so stranded rows are clearable by script without a page existing.

**Pre-existing bug found along the way:** collection item SQL does not join `ModelVersion`, so items
are paginated *before* being discarded during hydration — `limit + 1` cursor math runs on the
pre-filter set. Any versionless model in a collection produces short pages and an item count that
does not match what renders. This is true today, independent of merges.

## Build plan

Roughly 2–3 days for the reusable version; ~1 day for a one-off script plus preflight.

| Piece | Effort |
|---|---|
| Manifest + executor | ~half day |
| Preflight / conflict report | ~2 hrs |
| Invalidation | ~1 hr |
| `Model.mergedIntoId` + 301 | ~half day |
| Tests | ~half–1 day |

**Make the manifest schema-derived and guarded.** `schema.full.prisma` has 63 `modelId` references.
A hand-written manifest covers today's tables and nothing tells you when someone adds the next one —
the merge just silently leaves rows behind. Add a convention test that parses the schema, finds every
model carrying a `modelId` field, and asserts each is classified `update` / `insert+delete` /
`requeue` / `ignore` / `needs-human`. Same idiom as `no-pk-addressed-engagement-write`, which argues
for exactly this: hand-enumerated tests catch the tables that already exist, a guard catches the next
one. Wire it into `test:lint-rules` in the same commit.

**Write an audit blob.** There is no undo. Record every row moved and every row deleted, keyed by the
merge — the deleted collection items and dropped `Hide` rows are otherwise gone with no record.

**It belongs in the main app, not `apps/moderator`.** The merge is ~30% SQL and ~70% invalidation, and
every invalidation helper is main-app server code. A SvelteKit page would have to call back into the
main app for all of it. Build `model.merge` and `model.mergePreflight` as moderator-scoped tRPC
procedures; a moderator-app page can be a thin caller later.

**Start with the preflight.** Read-only, no writes, callable on any pair. It independently verifies
the numbers below and tells you whether the general tool is worth finishing.

## The Wan case, as measured 2026-08-25

Target shape: rename `1992179` → `Wan Video (api)` and `2516180` → `Wan Image (api)`. The image side
is a **pure rename, zero migration**. Only one real merge is needed: `2516027` → `1992179`.

`1817671` (`Wan Video 2.2`) ships real weights and stays where it is.

Mechanical work for `2516027 → 1992179`: 1 version move (`2828005`), 28 comments, 231 reviews,
125 engagements (17 dedupe), 187 collection items (21 dedupe), 1 tag, 2 `ModelBaseModelMetric` rows.

Every "needs a human" class is empty for this pair:

| Blocker | Count |
|---|---|
| `Thread` rows | 0 on all three Wan models — their comments are all in the legacy `Comment` table |
| `ModelFlag` | 0 |
| `ModelDescription` | 0 |
| `CollectionItemScore` on colliding items | 0 |
| Mixed-type engagement pairs | 0 (14 Notify/Notify, 2 Hide/Hide, 1 Mute/Mute) |
| Divergent `Model` policy columns | 0 — identical across all 17 checked |

Known data smells in the same neighbourhood, unrelated to the merge: `WanImage27` is filed under
`familyId: 5` commented "Wan Video Family", and `ModelBaseModelMetric` carries a stray
`'Wan 2.7 Video'` alongside the correct `'Wan Video 2.7'`.
