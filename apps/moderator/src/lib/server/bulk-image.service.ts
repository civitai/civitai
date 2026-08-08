import { sql } from '@civitai/db/kysely';
import { NsfwLevel } from '@civitai/shared';
import { dbRead } from './db';
import type { MediaType } from '$lib/media/edge-url';

// Retool's Bulk Image Manager: find a batch of images by one of five sources, then act on the batch.
//
// Retool needed ten queries for five sources because one of its queries cannot join to another's
// output — `FindModelVersions` → `FindPosts` → `FindmagesFromPosts` is one join expressed as three
// round trips. Here each source is a single query.
//
// The `Source`/`Link` columns Retool selected are deliberately absent: they hardcode
// `image.civitai.com` and, in PostQuery, `civitai.red` — so a moderator clicking through from that
// one landed on the wrong site. Media URLs come from $lib/media/edge-url, links from $lib/entity-url.

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
] as const;

// EXISTS, not Retool's LEFT JOINs: an image attached to two ImageConnection rows came back twice
// there, doubling it in the grid and in any count taken off the same query.
const extraColumns = [
  sql<string | null>`i."meta" ->> 'prompt'`.as('prompt'),
  sql<string | null>`i."meta" ->> 'negativePrompt'`.as('negativePrompt'),
  sql<boolean>`EXISTS (SELECT 1 FROM "User" u WHERE u."profilePictureId" = i."id")`.as(
    'isProfilePicture'
  ),
  sql<boolean>`EXISTS (SELECT 1 FROM "ImageConnection" ic WHERE ic."entityId" = i."id")`.as(
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
async function batchFrom(base: ImageBase, limit: number): Promise<BulkBatch> {
  const [rows, total] = await Promise.all([
    base
      .select([...IMAGE_COLUMNS, ...extraColumns])
      .orderBy('i.id', 'desc')
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

export async function getImagesForPost(postId: number, limit = 200): Promise<BulkBatch> {
  return batchFrom(imageBase().where('i.postId', '=', postId), limit);
}

/** Every image across every VERSION of a model — Retool's three chained queries as one join. */
export async function getImagesForModel(modelId: number, limit = 200): Promise<BulkBatch> {
  const posts = dbRead
    .selectFrom('Post')
    .select('id')
    .where('modelVersionId', 'in', (eb) =>
      eb.selectFrom('ModelVersion').select('id').where('modelId', '=', modelId)
    );

  return batchFrom(imageBase().where('i.postId', 'in', posts), limit);
}

export async function getImagesForModelVersion(
  modelVersionId: number,
  limit = 200
): Promise<BulkBatch> {
  const posts = dbRead.selectFrom('Post').select('id').where('modelVersionId', '=', modelVersionId);

  return batchFrom(imageBase().where('i.postId', 'in', posts), limit);
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
