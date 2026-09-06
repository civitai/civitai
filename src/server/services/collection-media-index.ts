import { Prisma } from '@prisma/client';
import { chunk } from 'lodash-es';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { collectionsSearchIndex } from '~/server/search-index';

// Removing a model or an image leaves every collection that contained it holding a
// stale denormalized snapshot, and nothing about the removal reaches the collections
// index on its own: `prepareBatches` in collections.search-index.ts filters on
// `c."createdAt" >= lastUpdatedAt`, so the incremental sweep only ever sees NEWLY
// CREATED collections. That `createdAt` filter is deliberate (it stops an old edit
// triggering a full reindex) and is not the thing to change — an existing collection
// is only revisited via an explicit enqueue, so the enqueue is what was missing.
//
// `Update`, never `Delete`: the collection still exists, only its document needs
// rebuilding. The index resolves item images by joining live `Image`/`Post`/
// `ModelVersion`/`Model`, so re-running it over the collection drops the vanished
// image on its own — the document self-heals. A `Delete` would evict a collection
// that is still perfectly real.
//
// This is a LEAF module on purpose. It is imported by both model.service and
// image.service, and its sibling collection-index-sync.ts already imports
// image.service (for `queueImageSearchIndexUpdate`) — putting these functions there
// would make image.service import a module that imports image.service back. Nothing
// here imports another service, so no cycle is possible from either caller.
//
// EVERY exported function here is non-throwing by contract. They are bookkeeping for
// a search index, called around deletes that have either already committed or are
// about to; a failure must cost a stale document, never the user's delete. Failures
// are logged rather than swallowed, because silence is indistinguishable from "this
// model was in no collections".

// `CollectionItem.modelId` / `.imageId` are both `onDelete: Cascade`, so on a HARD
// delete the membership rows disappear with the row that owned them. Callers on a
// hard-delete path must therefore resolve ids BEFORE the delete; a soft delete or an
// unpublish leaves the rows in place and can resolve after.
//
// Each column is separately indexed in the live database — "CollectionItem_modelId"
// and "CollectionItem_imageId_lookup", both BTREE. (The Prisma schema annotates these
// `type: Hash`; the deployed indexes are btree, and it is the deployed ones the
// planner uses.) An index is only reached when a statement constrains ONE of the two
// columns, which is why every query below keeps them in separate statements or
// separate UNION legs rather than joining them with `OR` — see the note on
// `getCollectionIdsForModelCascade`.
const DEFAULT_COLLECTION_CAP = 10_000;

// One enqueue writes its ids into a Redis queue as a single command. Chunking keeps
// that command bounded for the pathological "model is in thousands of collections"
// case rather than sending one enormous payload.
const ENQUEUE_BATCH_SIZE = 500;

/**
 * `dropped` is a LOWER BOUND on the collections left un-queued, never an exact count.
 *
 * Every lookup stops at `LIMIT cap + 1`, so the largest overflow any of them can
 * observe is one — the query is deliberately not in a position to learn the true
 * total, and paying for it would mean removing the cap that makes these safe. The
 * multi-column case compounds it: `getCollectionIdsForMedia` runs one statement per
 * column, each independently capped, so both can truncate before the union is formed.
 *
 * `dropped > 0` is still an exact signal that something was dropped: a truncating leg
 * returns `cap + 1` distinct ids, so the union is always at least `cap + 1`. Only the
 * magnitude is unknown, which is why the warning is worded "at least N".
 */
export type CollectionsToRebuild = { collectionIds: number[]; dropped: number };

const EMPTY: CollectionsToRebuild = { collectionIds: [], dropped: 0 };

function applyCap(rows: { collectionId: number }[], cap: number): CollectionsToRebuild {
  const collectionIds = [...new Set(rows.map((r) => r.collectionId))];
  return {
    collectionIds: collectionIds.slice(0, cap),
    dropped: Math.max(0, collectionIds.length - cap),
  };
}

function logFailure(name: string, source: string, message: string, error: unknown) {
  logToAxiom({ type: 'error', name, message: `${source}: ${message}`, source, error }).catch(
    () => undefined
  );
}

/**
 * Resolve the collections that contain the given models/images.
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

  try {
    const rows: { collectionId: number }[] = [];
    // Raw DISTINCT rather than Prisma's `distinct`, because the cap has to apply to
    // DISTINCT COLLECTIONS. Prisma's `distinct` has historically been applied after
    // the rows come back, which would make `take` a cap on membership ROWS instead —
    // a handful of huge collections could then exhaust it while naming few documents.
    // One statement per column, never one statement with an `OR` across both: a
    // two-column `OR` is non-sargable and costs a full index scan of a ~208M-row
    // table (the note on `getCollectionIdsForModelCascade` has the measurements).
    // Each statement here is independently capped, so `dropped` is a lower bound.
    if (uniqueModelIds.length)
      rows.push(
        ...(await dbWrite.$queryRaw<{ collectionId: number }[]>`
          SELECT DISTINCT "collectionId" FROM "CollectionItem"
          WHERE "modelId" IN (${Prisma.join(uniqueModelIds)})
          LIMIT ${cap + 1}
        `)
      );
    if (uniqueImageIds.length)
      rows.push(
        ...(await dbWrite.$queryRaw<{ collectionId: number }[]>`
          SELECT DISTINCT "collectionId" FROM "CollectionItem"
          WHERE "imageId" IN (${Prisma.join(uniqueImageIds)})
          LIMIT ${cap + 1}
        `)
      );

    return applyCap(rows, cap);
  } catch (error) {
    logFailure(
      'collection-media-index-resolve-failed',
      source,
      'failed to resolve collections for removed media',
      error
    );
    return EMPTY;
  }
}

/**
 * Resolve the collections a PERMANENT model delete will orphan — both the model's own
 * membership and that of every gallery image the cascade takes with it.
 *
 * Must be called BEFORE the deleting transaction. `CollectionItem` cascades from both
 * `Model` and `Image`, so after the commit there is nothing left to resolve; and it
 * cannot be moved inside the transaction either, because a failed statement aborts a
 * Postgres transaction outright — a hiccup in this bookkeeping read would take the
 * whole delete down with it. Run outside and non-throwing, it can only cost a reindex.
 *
 * The image sub-select mirrors the transaction's own post lookup (versions of this
 * model, posts owned by the model's owner) so the two see the same image set.
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
    // 🔴 The two columns MUST stay in separate UNIONed legs. Bridging them with a
    // single `OR` makes the predicate non-sargable on a ~208M-row table: Postgres can
    // then use NEITHER "CollectionItem_modelId" NOR "CollectionItem_imageId_lookup",
    // and falls back to scanning an unrelated index
    // ("CollectionItem_unique_entity_with_model3d_key") end to end with the whole
    // condition as a post-scan Filter — an estimated 43.3M rows, total cost 3,336,745.
    // The `LIMIT` does not rescue it: its own node estimates 309,852 on the assumption
    // that the cap fills early, but for the ordinary case of a model in a handful of
    // collections the de-duplication cannot conclude until the scan is essentially
    // exhausted, so the realistic figure is the full one.
    //
    // Split into legs, each probes its own index: total cost 73.76, both legs
    // index-only scans. Verified to survive parameterisation, which is what Prisma
    // actually sends — the generic plan keeps both index conditions
    // ("modelId" = $1, "imageId" = i.id) at cost 74.52.
    //
    // Plans read with EXPLAIN (no ANALYZE) against a read replica. This query runs on
    // the permanent-delete path.
    const rows = await dbWrite.$queryRaw<{ collectionId: number }[]>`
      SELECT DISTINCT x."collectionId" FROM (
        SELECT ci."collectionId" FROM "CollectionItem" ci WHERE ci."modelId" = ${modelId}
        UNION
        SELECT ci."collectionId" FROM "CollectionItem" ci
        WHERE ci."imageId" IN (
              SELECT i.id
              FROM "Image" i
              JOIN "Post" p ON p.id = i."postId"
              JOIN "ModelVersion" mv ON mv.id = p."modelVersionId"
              JOIN "Model" m ON m.id = mv."modelId" AND m."userId" = p."userId"
              WHERE mv."modelId" = ${modelId}
            )
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
  dropped = 0,
  source,
  cap = DEFAULT_COLLECTION_CAP,
}: CollectionsToRebuild & {
  /** Names the removal path in logs, e.g. 'model-delete'. */
  source: string;
  cap?: number;
}) {
  if (!collectionIds.length) return { queued: 0, dropped };

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
    return { queued: 0, dropped };
  }

  if (dropped > 0)
    // Named, not silent: past the cap those documents stay stale until a full
    // reindex, and nobody can notice that from an absent log line. "at least" is
    // load-bearing — see the note on CollectionsToRebuild; the true overflow is
    // capped out of view, so an exact figure here would be a fabricated one.
    logToAxiom({
      type: 'warning',
      name: 'collection-media-index-enqueue-truncated',
      message: `${source}: capped at ${cap} collections; at least ${dropped} more remain stale until a full reindex.`,
      source,
      cap,
      dropped,
    }).catch(() => undefined);

  return { queued: collectionIds.length, dropped };
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
