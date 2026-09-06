import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom, safeError } from '~/server/logging/client';
import { collectionsSearchIndex } from '~/server/search-index';

// Removing a model or an image leaves every collection that showed it holding a stale
// denormalized snapshot, and nothing about the removal reaches the collections index
// on its own: `prepareBatches` in collections.search-index.ts filters on
// `c."createdAt" >= lastUpdatedAt`, so the incremental sweep only ever sees NEWLY
// CREATED collections. That `createdAt` filter is deliberate (it stops an old edit
// triggering a full reindex) and is not the thing to change — an existing collection
// is only revisited via an explicit enqueue, so the enqueue is what was missing.
//
// `Update`, never `Delete`: the collection still exists, only its document needs
// rebuilding. A `Delete` would evict a collection that is still perfectly real.
//
// 🔴 AN IMAGE REACHES A COLLECTION DOCUMENT BY SEVEN ROUTES, ONLY ONE OF WHICH IS A
// `CollectionItem.imageId` ROW. Resolving by that column alone — the obvious reading —
// misses six of them, including the two most common.
//
// 🔴 ENUMERATE FROM `pullData` AND `transformData`, NOT FROM THE CTEs. An earlier
// version of this comment said SIX and derived them from the item-image CTE list; that
// method structurally cannot see route 7, which is a separate `findMany`. If you add a
// route, the question to ask is "what image ids does the document contain", not "what
// does the big CTE join".
//
//   1. imageItemImage    CollectionItem.imageId   -> the image directly
//   2. postItemImage     CollectionItem.postId    -> that post's FIRST image
//   3. modelItemImage    CollectionItem.modelId   -> image -> Post -> ModelVersion -> Model
//   4. articleItemImage  CollectionItem.articleId -> Article.coverId
//   5. model3dItemImage  CollectionItem.model3dId -> Model3D.thumbnailImageId
//   6. the collection's own cover, Collection.imageId
//   7. the owner's avatar, User.profilePictureId -> Collection.userId
//      (fetched by a separate `db.image.findMany` in pullData and shipped as
//       `user.profilePicture` on EVERY collection document — not a CTE at all)
//
// ⚠️ ROUTE 7 IS NARROWER THAN THE OTHER SIX, AND ONLY COVERS DELETING A *LIVE* AVATAR.
// It matches `u."profilePictureId" IN (ids)`, i.e. images that are SOMEONE'S AVATAR
// RIGHT NOW. The usual way an avatar image dies is the deferred reaper, and that path
// cannot match: `remove-replaced-images` calls `getStillReferencedImageIds`, which
// filters out every id that is still a `profilePictureId`, before it calls
// `deleteImages`. So for a REPLACED avatar this leg resolves zero collections, by
// construction, every time. `deleteUser` is the same shape — it deletes the user's
// collections before their images.
//
// The gap that leaves is real and is NOT closed here: a user changes their avatar, the
// old Image row and its object are destroyed 30 days later, and every collection they
// own still ships `user.profilePicture` pointing at a dead url. Closing it needs an
// enqueue at REPLACEMENT time, which is a different trigger from removal and outside
// what this module is wired to. Tracked separately. The leg is kept because it is
// correct for the case it does match (a moderator or ingestion delete of a live
// avatar) and costs ~28, bounded because `profilePictureId` is `@unique`.
//
// Route 6 is the one that matters most on screen: CollectionCard renders
// `if (data.image) return [data.image]`, so a cover WINS over every item image, and
// most public collections with a cover use one that is not among their own items.
//
// The joins for routes 2-5 mirror the CTEs' own conditions — including
// `m."userId" = p."userId"` — so this and the index agree on which image a collection
// would show.
//
// This is a LEAF module on purpose. It is imported by both model.service and
// image.service, and its sibling collection-index-sync.ts already imports
// image.service (for `queueImageSearchIndexUpdate`), so putting these functions there
// would make image.service import a module that imports image.service back. Nothing
// here imports another service, so no cycle is possible from either caller.
//
// EVERY exported function is non-throwing by contract. They are bookkeeping for a
// search index, called around deletes that have either already committed or are about
// to; a failure must cost a stale document, never the user's delete. Failures are
// logged rather than swallowed, because silence is indistinguishable from "this model
// was in no collections".

// `CollectionItem.modelId` / `.postId` / `.imageId` are all `onDelete: Cascade`, so on
// a HARD delete the membership rows disappear with the row that owned them. Callers on
// a hard-delete path must therefore resolve ids BEFORE the delete.
//
// ⚠️ `Collection.imageId` and `User.profilePictureId` are NOT cascade-cleared, and in
// the deployed database they are not even foreign keys — `Collection` carries exactly
// one FK (`Collection_userId_fkey`), so a cover can and does point at an `Image` row
// that no longer exists. Nothing here depends on that: routes 6 and 7 are resolved
// before the delete like the rest. It is recorded because the Prisma schema's
// `onDelete: SetNull` reads like a guarantee the database does not actually make.
//
// 🔴 EVERY LEG MUST BE INDEPENDENTLY INDEXABLE. Bridging two columns with an `OR`
// makes the predicate non-sargable and costs a full scan of a ~208M-row table, so the
// legs stay in separate UNION branches. Do not merge them into one `WHERE ... OR ...`.
const DEFAULT_COLLECTION_CAP = 10_000;

// One enqueue writes its ids into a Redis queue as a single command. Chunking keeps
// that command bounded for the pathological "model is in tens of thousands of
// collections" case rather than sending one enormous payload.
const ENQUEUE_BATCH_SIZE = 500;

/**
 * `truncated` says only THAT the cap was reached, never by how much.
 *
 * Every lookup stops at `LIMIT cap + 1`, so the largest overflow any of them can
 * observe is one — the query is deliberately not in a position to learn the true
 * total. Reporting a number here would mean reporting `1` in exactly the case the
 * warning exists for: real models sit far past the cap (measured: one in 86,153
 * distinct collections), so "1 more is stale" would understate by five orders of
 * magnitude. The overflow is unknown, and the warning says so.
 */
export type CollectionsToRebuild = { collectionIds: number[]; truncated: boolean };

const EMPTY: CollectionsToRebuild = { collectionIds: [], truncated: false };

function applyCap(rows: { collectionId: number }[], cap: number): CollectionsToRebuild {
  const collectionIds = [...new Set(rows.map((r) => r.collectionId))];
  return { collectionIds: collectionIds.slice(0, cap), truncated: collectionIds.length > cap };
}

function logFailure(name: string, source: string, message: string, error: unknown) {
  // `safeError`, never the raw Error: `logToAxiom` JSON.stringifies its payload and an
  // Error has no enumerable own properties, so a bare one serialises to `{}` — which
  // records that something failed while discarding the only part worth logging.
  logToAxiom({
    type: 'error',
    name,
    message: `${source}: ${message}`,
    source,
    error: safeError(error),
  }).catch(() => undefined);
}

export const COVER_INDEX_NAME = 'Collection_imageId_idx';

/**
 * Is the cover leg's index present AND USABLE?
 *
 * 🔴 `pg_class` alone is NOT sufficient, and getting this wrong fails OPEN. A
 * `CREATE INDEX CONCURRENTLY` row appears in `pg_class` from the START of the build
 * and stays there permanently if the build fails — so a name-only check returns true
 * throughout a multi-minute build of a 2.8 GB heap, and forever after a failure. That
 * is precisely the window this gate exists to cover: the deploy-then-migrate ordering
 * would switch the cover leg on while the index is still being built, and every image
 * delete would pay the sequential scan concurrently with the build, on the primary,
 * up to five at a time (`deleteImages` runs `Limiter({ batchSize: 100 })`, whose
 * default concurrency is 5). `indisvalid AND indisready` is what makes the gate mean
 * "usable by the planner" rather than "someone started building this once".
 *
 * Schema-qualified because `relname` is not unique across schemas and this database
 * has a second one (`fk_remediation_backup`).
 *
 * A catalog lookup, not a cached flag: two index scans, cost 5.01 — far less than the
 * seven-leg query it guards — and re-reading it means the leg starts working the
 * moment the index becomes valid, with no deploy or restart.
 *
 * Once the index is valid in every environment, this gate and its branch can go.
 */
async function coverIndexExists() {
  const rows = await dbWrite.$queryRaw<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_index x ON x.indexrelid = c.oid
      WHERE c.relname = ${COVER_INDEX_NAME}
        AND c.relkind = 'i'
        AND c.relnamespace = 'public'::regnamespace
        AND x.indisvalid
        AND x.indisready
    ) AS "present"
  `;
  return rows[0]?.present === true;
}

/**
 * Collections whose document shows any of these images, by all seven routes.
 *
 * Plans verified with EXPLAIN on a read replica. Five legs are single-index probes
 * (CollectionItem_imageId_lookup, CollectionItem_postId_lookup, CollectionItem_modelId,
 * CollectionItem_model3dId_idx, and User_profilePictureId_key + Collection_userId_idx
 * for the avatar). The article leg is NOT a probe — `CollectionItem_article_idx` is
 * `("collectionId","articleId")` and nothing leads on `articleId`, so it scans that
 * partial index: row estimate 271 per outer row, against 6 for the postId leg. It is
 * bounded — the index is 7,712 kB — so it is kept rather than given one of its own.
 * The cover leg is included only when its index is valid; see `coverIndexExists`.
 */
function imageLegsSql(imageIds: number[], cap: number, includeCover: boolean) {
  const ids = Prisma.join(imageIds);
  const coverLeg = includeCover
    ? Prisma.sql`
      UNION
      SELECT c.id AS "collectionId" FROM "Collection" c WHERE c."imageId" IN (${ids})`
    : Prisma.empty;
  return dbWrite.$queryRaw<{ collectionId: number }[]>`
    SELECT DISTINCT x."collectionId" FROM (
      SELECT ci."collectionId" FROM "CollectionItem" ci WHERE ci."imageId" IN (${ids})
      ${coverLeg}
      UNION
      SELECT ci."collectionId" FROM "CollectionItem" ci
        WHERE ci."postId" IN (
          SELECT i."postId" FROM "Image" i WHERE i.id IN (${ids}) AND i."postId" IS NOT NULL)
      UNION
      SELECT ci."collectionId" FROM "CollectionItem" ci
        WHERE ci."modelId" IN (
          SELECT m.id FROM "Image" i
          JOIN "Post" p ON p.id = i."postId"
          JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
          JOIN "Model" m ON m.id = mv."modelId" AND m."userId" = p."userId"
          WHERE i.id IN (${ids}))
      UNION
      SELECT ci."collectionId" FROM "CollectionItem" ci
        WHERE ci."articleId" IN (SELECT a.id FROM "Article" a WHERE a."coverId" IN (${ids}))
      UNION
      SELECT ci."collectionId" FROM "CollectionItem" ci
        WHERE ci."model3dId" IN (
          SELECT m3.id FROM "Model3D" m3 WHERE m3."thumbnailImageId" IN (${ids}))
      UNION
      SELECT c.id AS "collectionId" FROM "Collection" c
        JOIN "User" u ON u.id = c."userId"
        WHERE u."profilePictureId" IN (${ids})
    ) x
    LIMIT ${cap + 1}
  `;
}

/**
 * Resolve the collections whose documents show any of the given images.
 *
 * Reads through `dbWrite` so a just-committed transaction is visible — the replica may
 * still be behind, and a missed row here is a permanently stale document, not a late
 * one. Never throws: callers run this immediately before their delete, so an exception
 * would cancel the deletion the user actually asked for.
 */
export async function getCollectionIdsForImages({
  imageIds,
  source = 'unknown',
  cap = DEFAULT_COLLECTION_CAP,
}: {
  imageIds: number[];
  source?: string;
  cap?: number;
}): Promise<CollectionsToRebuild> {
  const uniqueImageIds = [...new Set(imageIds)];
  if (!uniqueImageIds.length) return EMPTY;

  // 🔴 The catalog probe gets its OWN catch. Six of the seven legs do not depend on the
  // cover index, so a timeout or connection blip on this one extra round-trip must not
  // decide whether they run at all — inside the outer try it would send the whole
  // resolve to the catch and return nothing.
  let withCover = false;
  try {
    withCover = await coverIndexExists();
  } catch (error) {
    logFailure(
      'collection-media-index-cover-probe-failed',
      source,
      `could not determine whether "${COVER_INDEX_NAME}" is usable; continuing without the cover leg`,
      error
    );
  }

  if (!withCover)
    logToAxiom({
      type: 'warning',
      name: 'collection-media-index-cover-leg-skipped',
      message: `${source}: "${COVER_INDEX_NAME}" is not present and valid, so collections whose COVER is a removed image are not being re-indexed. Apply the migration that creates it.`,
      source,
    }).catch(() => undefined);

  try {
    return applyCap(await imageLegsSql(uniqueImageIds, cap, withCover), cap);
  } catch (error) {
    logFailure(
      'collection-media-index-resolve-failed',
      source,
      'failed to resolve collections for removed images',
      error
    );
    return EMPTY;
  }
}

/**
 * Resolve the collections a PERMANENT model delete will orphan — the model's own
 * membership, plus the posts and gallery images the cascade takes with it.
 *
 * Must be called BEFORE the deleting transaction. `CollectionItem` cascades from
 * `Model`, `Post` AND `Image`, so after the commit there is nothing left to resolve;
 * and it cannot be moved inside the transaction either, because a failed statement
 * aborts a Postgres transaction outright — a hiccup in this bookkeeping read would
 * take the whole delete down with it. Run outside and non-throwing, it can only cost
 * a reindex.
 *
 * The post and image sub-selects mirror the deleting transaction's own lookups
 * (versions of this model, posts owned by the model's owner) so the two agree on
 * which rows are going away.
 */
export async function getCollectionIdsForModelCascade({
  modelId,
  source = 'model-perma-delete',
  cap = DEFAULT_COLLECTION_CAP,
}: {
  modelId: number;
  source?: string;
  cap?: number;
}): Promise<CollectionsToRebuild> {
  try {
    // 🔴 Three UNIONed legs, never one `WHERE ... OR ... OR ...`. Measured on a read
    // replica: the OR form cannot use any of the three indexes and degrades to a
    // 43.3M-row scan of an unrelated index with the whole condition as a post-scan
    // Filter (cost 3,336,745); as separate legs every branch is an index scan
    // (cost 89.68). This runs on the permanent-delete path.
    const rows = await dbWrite.$queryRaw<{ collectionId: number }[]>`
      SELECT DISTINCT x."collectionId" FROM (
        SELECT ci."collectionId" FROM "CollectionItem" ci WHERE ci."modelId" = ${modelId}
        UNION
        SELECT ci."collectionId" FROM "CollectionItem" ci
          WHERE ci."postId" IN (
            SELECT p.id FROM "Post" p
            JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
            JOIN "Model" m ON m.id = mv."modelId" AND m."userId" = p."userId"
            WHERE mv."modelId" = ${modelId})
        UNION
        SELECT ci."collectionId" FROM "CollectionItem" ci
          WHERE ci."imageId" IN (
            SELECT i.id FROM "Image" i
            JOIN "Post" p ON p.id = i."postId"
            JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
            JOIN "Model" m ON m.id = mv."modelId" AND m."userId" = p."userId"
            WHERE mv."modelId" = ${modelId})
      ) x
      LIMIT ${cap + 1}
    `;
    return applyCap(rows, cap);
  } catch (error) {
    logFailure(
      'collection-media-index-resolve-failed',
      source,
      `failed to resolve collections for model ${modelId}`,
      error
    );
    return EMPTY;
  }
}

/**
 * Queue a rebuild of the given collections.
 *
 * Never throws: every caller runs this AFTER its delete has committed, so an exception
 * would shortcut the cleanup steps that follow (S3 objects, bid cleanup, cache busts)
 * and leak far more than a stale thumbnail.
 */
export async function enqueueCollectionRebuild({
  collectionIds,
  truncated = false,
  source,
  cap = DEFAULT_COLLECTION_CAP,
}: CollectionsToRebuild & {
  /** Names the removal path in logs, e.g. 'image-delete'. */
  source: string;
  cap?: number;
}) {
  if (!collectionIds.length) return { queued: 0, truncated };

  try {
    for (const batch of chunk(collectionIds, ENQUEUE_BATCH_SIZE)) {
      await collectionsSearchIndex.queueUpdate(
        batch.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update }))
      );
    }
  } catch (error) {
    logFailure(
      'collection-media-index-enqueue-failed',
      source,
      'failed to queue collection search index update',
      error
    );
    return { queued: 0, truncated };
  }

  if (truncated)
    // Named, not silent: past the cap those documents stay stale until a full reindex,
    // and nobody can notice that from an absent log line. No figure is quoted — see
    // the note on CollectionsToRebuild; the lookup stops one past the cap, so any
    // number here would be `1` however large the real overflow is.
    logToAxiom({
      type: 'warning',
      name: 'collection-media-index-enqueue-truncated',
      message: `${source}: capped at ${cap} collections; an unknown number beyond the cap remain stale until a full reindex.`,
      source,
      cap,
    }).catch(() => undefined);

  return { queued: collectionIds.length, truncated };
}
