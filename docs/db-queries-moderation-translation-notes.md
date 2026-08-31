# Moderation port — Prisma→Kysely translation deviations (for review)

The main-app moderation queries were mostly **Prisma** (and some raw `$queryRaw`/`pgDb.query`). Porting them to
Kysely is a translation, not a mechanical swap, so this lists every place the ported query is **not byte-identical**
to the source — grouped by risk. Every ported query is validated by a DB-backed `EXPLAIN` test against the live
schema, which is how several of the "latent source bugs" below were caught.

## 1. Latent source bugs surfaced by the EXPLAIN net

The query **as written in the main app is broken or invalid**; the port had to correct or work around it to plan.
These are worth fixing in the main app regardless of the migration.

| # | Where | Problem in the source | What the port did |
|---|---|---|---|
| 1 | `strike.service.ts` `evaluateStrikeEscalation` | `SELECT SUM(points) … FOR UPDATE` — Postgres rejects `FOR UPDATE` with an aggregate | Took the row lock in a subquery (`SELECT points … FOR UPDATE`), summed in the outer query. Same lock intent. |
| 2 | `user.service.ts` `getUsers` | `ORDER BY LENGTH(username)` was emitted **between** two `WHERE` `AND`s (invalid SQL when `query` is set); avatar read used unquoted `i.nsfwLevel` (folds to nonexistent `nsfwlevel`) with a `'None'` **text** default against an **int** column | Moved `ORDER BY` after the `WHERE`; quoted `"nsfwLevel"` with a `0` int default. Runtime behavior of the working paths is unchanged. |
| 3 | `user.service.ts` `removeAllContent` (engagements) | Prisma `{ OR: [{ userId, targetUserId }] }` is a **single AND'd** predicate (self-engagements only) — almost certainly an intended `OR` | Kept faithful (AND); flagged in a code comment. |
| 4 | `model-flag.service.ts` `upsertModelFlag` | Raw upsert SQL had **missing commas** (wouldn't execute) | Corrected so every scanned column round-trips. |
| 5 | `model-flag` — `ModelFlag.sfwOnly` | The column is declared in `schema.prisma` + the generated kysely types, but the **live DB table has no `sfwOnly` column** (unapplied migration; the repo applies migrations manually). EXPLAIN failed until it was dropped. | Dropped the `sfwOnly` write (still used in the `isFlagged` decision); documented to restore once the migration lands. **This is the `sfwOnly: Generated<boolean>` your IDE is on.** |
| 6 | `tag.service.ts` `disableTags` (model branch) | References a `disabled` column that **does not exist** on `TagsOnModels` — a faithful mirror of the source's own `TODO.fix`; that branch is dead/unplannable | Ported faithfully, flagged in a comment, excluded from EXPLAIN. |

## 2. Semantic translation choices (behavior-preserving, not byte-identical)

| # | Where | Deviation |
|---|---|---|
| 7 | `model.db.ts` `cannotPublish` filter | Prisma `{ not: { path:['cannotPublish'], equals:true } }` → `meta -> 'cannotPublish' IS DISTINCT FROM 'true'::jsonb` (includes null/false = "can publish"). Subtly different from Prisma's literal `NOT(x = true)` on a null key. |
| 8 | `model.db.ts` `workflowId` | Prisma json-path equals → `mf.metadata #>> '{trainingResults,workflowId}' = $` (text extraction). Fine for a string equals. |
| 9 | `model.db.ts` training feed | `jsonb_build_object` params needed explicit `::text`/`::int` casts (Postgres can't infer variadic `any` under EXPLAIN with bound params; Prisma's raw path typed them implicitly). Behavior unchanged. |
| 10 | `image-moderation.db.ts` `toggleImageFlag` | Collapsed the source's read-then-write-negation (2 statements) into one race-free `SET flag = NOT flag`. Net DB effect identical. |
| 11 | `model3d.db.ts` `updateModel3DNsfwLevelForThumbnailImage` | Reworked the CTE to filter on `thumbnailImageId` directly instead of read-ids-then-`IN(...)`. Same result set, one round-trip. |
| 12 | `entity-moderation.db.ts` | `Prisma.JsonNull` rendered as `sql\`'null'::jsonb\`` (JSON null literal, not SQL `NULL` — matches Prisma's `JsonNull` vs `DbNull`). |
| 13 | `csam.db.ts` `createCsamReport` / `createExternalCsamReport` | Use `returningAll().executeTakeFirst()` (not `…OrThrow`) to match the harness; Prisma `create` always returns a row, so production behavior is equivalent. |
| 14 | `article-rating-review.db.ts` `clearArticleModeratorLevel` | Sets `updatedAt` while the sibling `setArticleModeratorLevel` (from the moderator port) deliberately does not. Faithful to the main-app source; flagged for a consistency decision. |

**`@updatedAt` handling (systemic):** Prisma auto-bumped `@updatedAt` client-side; Kysely does not, and there is no
DB trigger. Ported **Prisma-builder** UPDATEs set `updatedAt` explicitly; ported **raw-SQL** UPDATEs intentionally do
**not** (the source raw SQL also didn't). Several source functions in fact use raw `$executeRaw` *specifically* to dodge
the bump (`recomputeArticleIngestionInTx`, `rescanArticle`) — the Kysely ports dodge it natively (typed builder, no
`updatedAt` in the `set`). Each is noted per-module in code comments.

## 3. Convergence reconcile notes (main-app vs already-ported moderator version)

These main-app functions overlap an existing package function (from the moderator port). Per the sweep's rule they were
**not duplicated**, but the two versions differ — reconcile which semantics win before adoption.

| # | Existing (package) | Main-app version | Difference |
|---|---|---|---|
| 15 | `getImageReviewCounts` | `getImageModerationCounts` | Existing excludes `appeal` and omits the reported-report `UNION`; main-app counts `appeal` (no ingestion gate) **and** adds the reported-image union. **Semantics differ.** |
| 16 | `getImageReviewQueue` (+`getReportedImageQueue`/`getAppealImageQueue`) | `getImageModerationReviewQueue` (monolith) | The monolith's **`tagReview` branch** (the `TagsOnImageNew.attributes` bitmask CTE) has **no equivalent** in any existing image-review function — port it when reconciling. |
| 17 | `getArticlesForModeration` | `getModeratorArticles` | Main-app version is **richer**: keyset cursor on `id` (vs offset paging) + a much wider nested select (`articleDetailSelect` + `moderatorNsfwLevel`). Not ported (needs the full nested selector). |
| 18 | `unpublishModel3d` | `unpublishModel3D` | Same write core (status→Unpublished by id). Kept the existing one; not duplicated. |
| 19 | `getComicReviewQueue` | `getModReviewQueue` | Same predicate; differ only in result shape (router returns Prisma-nested objects, the port returns a flat row). |

## 4. Structural notes

- **Transaction composers aren't EXPLAIN-tested.** Functions that open `db.transaction()` (e.g. `unpublishModelById`,
  `permaDeleteModelById`, `deletePost`, `unpublishBlockedModel`, `setModelsCategory`, `autoResolveArticleRatingReview`)
  can't run on the offline DummyDriver harness, so only their **constituent statement functions** are compiled and
  EXPLAINed. The composers are thin (open tx, call the tested statements). Consistent with the existing `deleteArticle`.
- **Cross-module imports (in-package):** `image-tags.db.ts` imports `upsertTagsOnImageNew` from `./tags-on-image.db`;
  `article-rating-review.db.ts` imports `refreshArticleNsfwLevelMany` from `./articles.db`. Relative, within the package.
- **Reconcile-before-adopt sources:** CSAM ported from `csam.service-new.ts` (the legacy `csam.service.ts` is a strict
  subset); user search = the SQL `getUsers` only (the Meilisearch `getUsersWithSearch` was skipped); comic moderation was
  extracted from the **inline `comics.router.ts`** procedures (there is no `comic.service.ts`).
- **Side-effects dropped everywhere** (left to the app, per the pure-query rule): search-index sync, cache busts,
  notifications, emails, redis, buzz charge/refund, ClickHouse, S3/CDN cleanup, session invalidation, Axiom logging, prom
  counters, orchestrator calls, feature-flag gating, `TRPCError` throws, and pagination shaping (`getPagingData`).

## 5. Organization / placement (done — entity-based)

The package is organized **by the primary table a query touches**, with **singular** entity-module names. The initial
port had some methods misplaced by concern; a reorg fixed it:

- **Singular renames:** `users→user`, `articles→article`, `reports→report`, `comics→comic`, `cosmetics→cosmetic`,
  `appeals→appeal` (subpaths + the one app consumer `report.service.ts` updated).
- **`user-moderation.db.ts` dissolved.** Every `User`-table op (`updateUser`, `setUserBan/…`, `getUsers`, …) plus
  user-owned sub-entities (UserLink/UserProfile/UserEngagement) moved to `user.db.ts`. The cross-entity
  `delete*ForUser` / `unpublish*ForUser` statements moved to their entity's module: `model`, `post`, `article`,
  `collection`, and new `image`, `comment`, `bounty`, `qa`, `resource-review`, `chat` modules.
- **`updateUser` signature** flattened to `updateUser(db, input: Updateable<DB['User']> & { id: number })`.

Concern modules that don't map to a single table (`image-moderation`, `image-review`, `sidebar-counts`, `mod-activity`,
`entity-moderation`, `user-restriction`, `model-flag`, `image-tags`, `tags-on-image`, `scanner`, `ingestion`,
`image-moderation-effects`, `image-rating-review`) were left as-is.
