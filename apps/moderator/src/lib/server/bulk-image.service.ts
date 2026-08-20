import { sql, type RawBuilder } from '@civitai/db/kysely';
import { NsfwLevel } from '@civitai/shared';
import { dbRead } from './db';
import { issueStrike } from './user-actions.service';
import type { MediaType } from '$lib/media/edge-url';

// Retool's Bulk Image Manager: find a batch of images by one of five sources, then act on the batch.
//
// Retool needed ten queries for five sources because one of its queries cannot join to another's
// output — `FindModelVersions` → `FindPosts` → `FindmagesFromPosts` is one join expressed as three
// round trips. Here each source is a single query.
//
// The `Source`/`Link` columns Retool selected are deliberately absent: they hardcode a domain per
// query. Media URLs come from $lib/media/edge-url and links from $lib/entity-url, which take
// `CIVITAI_APP_URL` — the one place the destination is decided.
//
// `civitai.red` is the INTENDED destination for moderator links (ClickUp 868kn8aa0: "every single link
// on moderator.civitai.com to civitai should go to the .red domain instead of .com"). Retool was
// inconsistent about it; do not "correct" a .red link to .com.

export type BulkImage = {
  id: number;
  url: string;
  name: string | null;
  type: MediaType;
  createdAt: Date;
  nsfwLevel: number;
  ingestion: string;
  blockedFor: string | null;
  needsReview: string | null;
  userId: number;
  postId: number | null;
  poi: boolean;
  minor: boolean;
  tosViolation: boolean;
  prompt: string | null;
  negativePrompt: string | null;
  isProfilePicture: boolean;
  hasConnection: boolean;
};

const IMAGE_COLUMNS = [
  'i.id',
  'i.url',
  'i.name',
  'i.type',
  'i.createdAt',
  'i.nsfwLevel',
  'i.ingestion',
  'i.blockedFor',
  'i.needsReview',
  'i.userId',
  'i.postId',
  'i.poi',
  'i.minor',
  // Every consumer of this set renders the flag row, and leaving one flag out of the set meant the same
  // image read as clean on one page and ToS'd on another.
  'i.tosViolation',
] as const;

// EXISTS, not Retool's LEFT JOINs: an image attached to two ImageConnection rows came back twice
// there, doubling it in the grid and in any count taken off the same query.
const extraColumns = [
  sql<string | null>`i."meta" ->> 'prompt'`.as('prompt'),
  sql<string | null>`i."meta" ->> 'negativePrompt'`.as('negativePrompt'),
  sql<boolean>`EXISTS (SELECT 1 FROM "User" u WHERE u."profilePictureId" = i."id")`.as(
    'isProfilePicture'
  ),
  sql<boolean>`EXISTS (SELECT 1 FROM "ImageConnection" ic WHERE ic."imageId" = i."id")`.as(
    'hasConnection'
  ),
];

/**
 * A batch is capped: a prolific model can carry tens of thousands of images and the page renders
 * every row it is given. `total` is the true size so a moderator knows a bulk action covers what is
 * on screen, NOT everything the source contains — the distinction that decides whether they act here
 * or reach for the per-user purge.
 */
export type BulkBatch = { items: BulkImage[]; total: number; truncated: boolean };

const imageBase = () => dbRead.selectFrom('Image as i');
type ImageBase = ReturnType<typeof imageBase>;

/**
 * Rows and count derived from ONE already-filtered builder. A predicate added to the rows but not the
 * count renders "150 of 300" next to "The whole set."
 */
/** `order: 'index'` is the author's own ordering within a post — what the site shows, and what a report
 *  about "the third image" refers to. Everywhere else newest-first is the useful order. */
async function batchFrom(
  base: ImageBase,
  limit: number,
  order: 'newest' | 'index' = 'newest'
): Promise<BulkBatch> {
  const ordered =
    order === 'index'
      ? base.orderBy(sql`"index" asc nulls last`).orderBy('i.id', 'asc')
      : base.orderBy('i.id', 'desc');
  const [rows, total] = await Promise.all([
    ordered
      .select([...IMAGE_COLUMNS, ...extraColumns])
      .limit(limit + 1)
      .execute(),
    base.select((eb) => eb.fn.countAll<string>().as('c')).executeTakeFirst(),
  ]);

  return {
    items: rows.slice(0, limit),
    total: Number(total?.c ?? 0),
    truncated: rows.length > limit,
  };
}

export async function getImagesForPost(
  postId: number,
  limit = 200,
  order: 'newest' | 'index' = 'newest'
): Promise<BulkBatch> {
  return batchFrom(imageBase().where('i.postId', '=', postId), limit, order);
}

/**
 * A resource's images are TWO sets, and only one hangs off `Post.modelVersionId`: the images the
 * creator posted to the version, its showcase. The gallery — everything on the site that used the
 * resource, which is where reportable content accumulates — joins through `ImageResourceNew`, the
 * table the main app's own gallery filters on. Posts alone returned the showcase and nothing else,
 * which reads as "the batch is small" rather than "the batch is wrong".
 *
 * A UNION of the two id sets, NOT `postId IN (...) OR EXISTS (...)`: an OR across two tables cannot
 * become a semi-join, so the planner falls back to a per-row subplan over all of `Image` — the
 * largest table here — and `batchFrom` runs the predicate twice, for the rows and for the count.
 * Each arm of the union drives its own index instead.
 */
const imagesOfVersions = (versionIds: RawBuilder<unknown>) =>
  sql<number>`
    SELECT im."id" FROM "Image" im
    JOIN "Post" p ON p."id" = im."postId"
    WHERE p."modelVersionId" IN (${versionIds})
    UNION
    SELECT irr."imageId" FROM "ImageResourceNew" irr
    WHERE irr."modelVersionId" IN (${versionIds})
  `;

/** Every image across every VERSION of a model — Retool's three chained queries as one join. */
export async function getImagesForModel(modelId: number, limit = 200): Promise<BulkBatch> {
  const versions = sql`SELECT mv."id" FROM "ModelVersion" mv WHERE mv."modelId" = ${modelId}`;
  return batchFrom(imageBase().where('i.id', 'in', imagesOfVersions(versions)), limit);
}

export async function getImagesForModelVersion(
  modelVersionId: number,
  limit = 200
): Promise<BulkBatch> {
  return batchFrom(
    imageBase().where('i.id', 'in', imagesOfVersions(sql`${modelVersionId}`)),
    limit
  );
}

export async function getImagesForCollection(
  collectionId: number,
  limit = 200
): Promise<BulkBatch> {
  // IN over the collection's image ids rather than a join: a collection holding two items for one
  // image would otherwise emit it twice, and a duplicate key takes the grid out at runtime.
  const imageIds = dbRead
    .selectFrom('CollectionItem')
    .select('imageId')
    .where('collectionId', '=', collectionId)
    .where('imageId', 'is not', null);

  return batchFrom(imageBase().where('i.id', 'in', imageIds), limit);
}

/**
 * `removedOnly` is Retool's `UserQuery5000` — `nsfwLevel = 32` is what `handleBlockImages` sets, so it
 * lists what has ALREADY been removed from an account. That is the restore path: confirm a purge
 * landed, or pull back one that went too wide.
 */
export async function getImagesForUser(
  userId: number,
  limit = 200,
  removedOnly = false
): Promise<BulkBatch> {
  const base = imageBase().where('i.userId', '=', userId);
  return batchFrom(removedOnly ? base.where('i.nsfwLevel', '=', NsfwLevel.Blocked) : base, limit);
}

/**
 * Retool's `textArea5` path: a list of image ids pasted straight in. A ticket, a CSAM report or a
 * script hands over ids, not a post — without this the moderator has to find each one's post or owner
 * and re-reach it through another source.
 */
export async function getImagesByIds(imageIds: number[], limit = 200): Promise<BulkBatch> {
  if (!imageIds.length) return { items: [], total: 0, truncated: false };
  return batchFrom(imageBase().where('i.id', 'in', imageIds), limit);
}

/**
 * The distinct OWNERS of a batch (Retool's GetBulkRemoveImageUserIdsForNotifs). A 300-image removal
 * spanning 40 accounts must send 40 notifications, not 300 — which is the whole reason Retool had a
 * separate query for it rather than notifying per row.
 */
export async function getBatchOwners(imageIds: number[]): Promise<number[]> {
  if (!imageIds.length) return [];
  const rows = await dbRead
    .selectFrom('Image')
    .select('userId')
    .distinct()
    .where('id', 'in', imageIds)
    .execute();
  return rows.map((r) => r.userId);
}

/**
 * How many of a batch are ALREADY blocked, read before the write. `/api/mod/remove-images` reports the
 * rows it FOUND, not the rows it changed, so re-removing a blocked batch comes back with a full count
 * and reads as work done. Taken here rather than fixed in the endpoint because that is a cross-app
 * change; subtracting a number this side is exact for the same submitted ids.
 */
export async function countBlockedImages(imageIds: number[]): Promise<number> {
  if (!imageIds.length) return 0;
  const row = await dbRead
    .selectFrom('Image')
    .select((eb) => eb.fn.countAll<string>().as('c'))
    .where('id', 'in', imageIds)
    .where('ingestion', '=', 'Blocked')
    .executeTakeFirst();
  return Number(row?.c ?? 0);
}

/**
 * Retool's `strikeCheckbox`, on both Bulk Image Manager and User Reports: a TOS removal and the strike
 * for it were one gesture. Owners are resolved SERVER-side from the ids rather than passed in — the
 * grid only holds the page in front of the moderator, and a selection can outlive it.
 */
export async function strikeBatchOwners(input: {
  imageIds: number[];
  /** The user-facing strike description — the same canned message the removal was filed under. */
  description: string;
  moderatorId: number;
}): Promise<{ struck: number; owners: number; error?: string }> {
  const owners = await getBatchOwners(input.imageIds);
  if (!owners.length) return { struck: 0, owners: 0, error: 'no owners could be resolved' };

  const results = await Promise.all(
    owners.map((userId) =>
      issueStrike({
        userId,
        description: input.description,
        internalNotes: `Issued with the removal of ${input.imageIds.length} image(s).`,
        moderatorId: input.moderatorId,
      })
    )
  );
  const failed = results.filter((r) => !r.ok) as { ok: false; error: string }[];
  return {
    struck: owners.length - failed.length,
    owners: owners.length,
    // The first reason, not a count: they share a cause (rate limit, endpoint down) far more often
    // than not, and a bare "3 failed" sends the moderator to the logs to find out why.
    error: failed.length ? failed[0].error : undefined,
  };
}
