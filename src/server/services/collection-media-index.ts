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
// 🔴 AN IMAGE REACHES A COLLECTION DOCUMENT BY SIX ROUTES, ONLY ONE OF WHICH IS A
// `CollectionItem.imageId` ROW. Resolving by that column alone — the obvious reading —
// misses five of them, including the two most common. Enumerated from the index's own
// CTEs (collections.search-index.ts) plus the document's cover field:
//
//   1. imageItemImage    CollectionItem.imageId  -> the image directly
//   2. postItemImage     CollectionItem.postId   -> that post's FIRST image
//   3. modelItemImage    CollectionItem.modelId  -> image -> Post -> ModelVersion -> Model
//   4. articleItemImage  CollectionItem.articleId-> Article.coverId
//   5. model3dItemImage  CollectionItem.model3dId-> Model3D.thumbnailImageId
//   6. the collection's own cover, Collection.imageId (SetNull, not a CollectionItem)
//
// Route 6 is the one that matters most on screen: CollectionCard renders
// `if (data.image) return [data.image]`, so a cover WINS over every item image, and
// most public collections with a cover use one that is not among their own items.
//
// The joins below mirror the CTEs' own conditions — including `m."userId" =
// p."userId"` — so this and the index agree on which image a collection would show.
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
// a hard-delete path must therefore resolve ids BEFORE the delete; a soft delete or an
// unpublish leaves the rows in place and can resolve after.
//
// 🔴 EVERY LEG MUST BE INDEPENDENTLY INDEXABLE. Bridging two columns with an `OR`
// makes the predicate non-sargable and costs a full scan of a ~208M-row table, so the
// legs stay in separate UNION branches and each was checked to produce its own index
// scan. Do not merge them back into one `WHERE ... OR ...`.
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
  // `safeError`, never the raw Error: `logToAxiom` JSON.stringifies its payload and a
  // bare Error serialises to `{}`, which would record that something failed while
  // discarding the only part worth logging.
  logToAxiom({
    type: 'error',
    name,
    message: `${source}: ${message}`,
    source,
    error: safeError(error),
  }).catch(() => undefined);
}

/** Collections holding these models as items. Membership rows only — a model item's
 * gallery image is resolved from the model, so no image walk is needed here. */
function modelLegSql(modelIds: number[], cap: number) {
  return dbWrite.$queryRaw<{ collectionId: number }[]>`
    SELECT DISTINCT "collectionId" FROM "CollectionItem"
    WHERE "modelId" IN (${Prisma.join(modelIds)})
    LIMIT ${cap + 1}
  `;
}

export const COVER_INDEX_NAME = 'Collection_imageId_idx';

/**
 * Is the cover leg's index present?
 *
 * 🔴 The cover leg is GATED on this, because without the index it is a parallel
 * sequential scan of a ~17.3M-row / 4.9 GB table — measured cost 451,531, against
 * ~10,000 for every other leg of the same query combined — on a user-facing delete
 * path, and `deleteImages` would pay it once per 100-image batch. Migrations here are
 * applied by hand, so "the migration ships in the same PR" does not mean the index
 * exists when this code first runs; the gate is what makes that ordering safe rather
 * than merely documented.
 *
 * A catalog lookup, not a cached flag: it is an index probe on pg_class costing far
 * less than the six-leg query it guards, and re-reading it means the leg starts
 * working the moment the migration is applied, with no deploy or restart.
 *
 * Once the index exists in every environment, this gate and its branch can be deleted.
 */
async function coverIndexExists() {
  const rows = await dbWrite.$queryRaw<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_class WHERE relname = ${COVER_INDEX_NAME} AND relkind = 'i'
    ) AS "present"
  `;
  return rows[0]?.present === true;
}

/**
 * Collections whose document shows any of these images, by all six routes.
 *
 * Plans verified with EXPLAIN on a read replica: five legs are index probes
 * (CollectionItem_imageId_lookup, CollectionItem_postId_lookup, CollectionItem_modelId,
 * CollectionItem_article_idx, CollectionItem_model3dId_idx). The sixth — the cover —
 * is included only when its index exists; see `coverIndexExists`.
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
    ) x
    LIMIT ${cap + 1}
  `;
}

/**
 * Resolve the collections whose documents show the given models/images.
 *
 * Reads through `dbWrite` so a just-committed transaction is visible — the replica may
 * still be behind, and a missed row here is a permanently stale document, not a late
 * one. Never throws: a caller on a hard-delete path runs this immediately before its
 * delete, so an exception would cancel the deletion the user actually asked for.
 */
export async function getCollectionIdsForMedia({
  modelIds = [],
  imageIds = [],
  source = 'unknown',
  cap = DEFAULT_COLLECTION_CAP,
}: {
  modelIds?: number[];
  imageIds?: number[];
  source?: string;
  cap?: number;
}): Promise<CollectionsToRebuild> {
  const uniqueModelIds = [...new Set(modelIds)];
  const uniqueImageIds = [...new Set(imageIds)];
  if (!uniqueModelIds.length && !uniqueImageIds.length) return EMPTY;

  // Each media kind is resolved by its own statement and caught separately: a failure
  // resolving images must not discard collections already found for models. Losing
  // half the answer is worse than reporting the half we have, because the half we have
  // is still correct.
  const rows: { collectionId: number }[] = [];

  if (uniqueModelIds.length) {
    try {
      rows.push(...(await modelLegSql(uniqueModelIds, cap)));
    } catch (error) {
      logFailure(
        'collection-media-index-resolve-failed',
        source,
        'failed to resolve collections for removed models',
        error
      );
    }
  }

  if (uniqueImageIds.length) {
    try {
      const withCover = await coverIndexExists();
      if (!withCover)
        logToAxiom({
          type: 'warning',
          name: 'collection-media-index-cover-leg-skipped',
          message: `${source}: "${COVER_INDEX_NAME}" is missing, so collections whose COVER is a removed image are not being re-indexed. Apply the migration that creates it.`,
          source,
        }).catch(() => undefined);
      rows.push(...(await imageLegsSql(uniqueImageIds, cap, withCover)));
    } catch (error) {
      logFailure(
        'collection-media-index-resolve-failed',
        source,
        'failed to resolve collections for removed images',
        error
      );
    }
  }

  // Checking the union is enough to catch a truncating leg, even though each statement
  // is capped independently: a leg that truncated returns exactly `cap + 1` distinct
  // ids, so the union is always at least `cap + 1` and `applyCap` sees it. What is NOT
  // recoverable is the magnitude — hence `truncated`, not a count.
  return applyCap(rows, cap);
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
  /** Names the removal path in logs, e.g. 'model-delete'. */
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

/**
 * Resolve + enqueue in one step, for the paths whose membership rows survive the
 * removal (a soft delete, an unpublish).
 */
export async function queueCollectionsForMedia({
  modelIds = [],
  imageIds = [],
  source,
  cap = DEFAULT_COLLECTION_CAP,
}: {
  modelIds?: number[];
  imageIds?: number[];
  source: string;
  cap?: number;
}) {
  const resolved = await getCollectionIdsForMedia({ modelIds, imageIds, source, cap });
  return enqueueCollectionRebuild({ ...resolved, source, cap });
}
