import { sql } from '@civitai/db/kysely';
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
  prompt: string | null;
  negativePrompt: string | null;
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
] as const;

const promptColumns = [
  sql<string | null>`i."meta" ->> 'prompt'`.as('prompt'),
  sql<string | null>`i."meta" ->> 'negativePrompt'`.as('negativePrompt'),
];

/**
 * A batch is capped: a prolific model can carry tens of thousands of images and the page renders
 * every row it is given. `total` is the true size so a moderator knows a bulk action covers what is
 * on screen, NOT everything the source contains — the distinction that decides whether they act here
 * or reach for the per-user purge.
 */
export type BulkBatch = { items: BulkImage[]; total: number; truncated: boolean };

async function batchFrom(
  build: (limit: number) => Promise<unknown[]>,
  count: () => Promise<number>,
  limit: number
): Promise<BulkBatch> {
  const [rows, total] = await Promise.all([build(limit + 1), count()]);
  return {
    items: rows.slice(0, limit) as BulkImage[],
    total,
    truncated: rows.length > limit,
  };
}

export async function getImagesForPost(postId: number, limit = 200): Promise<BulkBatch> {
  return batchFrom(
    (l) =>
      dbRead
        .selectFrom('Image as i')
        .select([...IMAGE_COLUMNS, ...promptColumns])
        .where('i.postId', '=', postId)
        .orderBy('i.id', 'desc')
        .limit(l)
        .execute(),
    async () =>
      Number(
        (
          await dbRead
            .selectFrom('Image')
            .select((eb) => eb.fn.countAll<string>().as('c'))
            .where('postId', '=', postId)
            .executeTakeFirst()
        )?.c ?? 0
      ),
    limit
  );
}

/** Every image across every VERSION of a model — Retool's three chained queries as one join. */
export async function getImagesForModel(modelId: number, limit = 200): Promise<BulkBatch> {
  const posts = dbRead
    .selectFrom('Post')
    .select('id')
    .where('modelVersionId', 'in', (eb) =>
      eb.selectFrom('ModelVersion').select('id').where('modelId', '=', modelId)
    );

  return batchFrom(
    (l) =>
      dbRead
        .selectFrom('Image as i')
        .select([...IMAGE_COLUMNS, ...promptColumns])
        .where('i.postId', 'in', posts)
        .orderBy('i.id', 'desc')
        .limit(l)
        .execute(),
    async () =>
      Number(
        (
          await dbRead
            .selectFrom('Image')
            .select((eb) => eb.fn.countAll<string>().as('c'))
            .where('postId', 'in', posts)
            .executeTakeFirst()
        )?.c ?? 0
      ),
    limit
  );
}

export async function getImagesForModelVersion(
  modelVersionId: number,
  limit = 200
): Promise<BulkBatch> {
  const posts = dbRead.selectFrom('Post').select('id').where('modelVersionId', '=', modelVersionId);

  return batchFrom(
    (l) =>
      dbRead
        .selectFrom('Image as i')
        .select([...IMAGE_COLUMNS, ...promptColumns])
        .where('i.postId', 'in', posts)
        .orderBy('i.id', 'desc')
        .limit(l)
        .execute(),
    async () =>
      Number(
        (
          await dbRead
            .selectFrom('Image')
            .select((eb) => eb.fn.countAll<string>().as('c'))
            .where('postId', 'in', posts)
            .executeTakeFirst()
        )?.c ?? 0
      ),
    limit
  );
}

export async function getImagesForCollection(
  collectionId: number,
  limit = 200
): Promise<BulkBatch> {
  return batchFrom(
    (l) =>
      dbRead
        .selectFrom('CollectionItem as ci')
        .innerJoin('Image as i', 'i.id', 'ci.imageId')
        .select([...IMAGE_COLUMNS, ...promptColumns])
        .where('ci.collectionId', '=', collectionId)
        .orderBy('i.id', 'desc')
        .limit(l)
        .execute(),
    async () =>
      Number(
        (
          await dbRead
            .selectFrom('CollectionItem')
            .select((eb) => eb.fn.countAll<string>().as('c'))
            .where('collectionId', '=', collectionId)
            .where('imageId', 'is not', null)
            .executeTakeFirst()
        )?.c ?? 0
      ),
    limit
  );
}

export async function getImagesForUser(userId: number, limit = 200): Promise<BulkBatch> {
  return batchFrom(
    (l) =>
      dbRead
        .selectFrom('Image as i')
        .select([...IMAGE_COLUMNS, ...promptColumns])
        .where('i.userId', '=', userId)
        .orderBy('i.id', 'desc')
        .limit(l)
        .execute(),
    async () =>
      Number(
        (
          await dbRead
            .selectFrom('Image')
            .select((eb) => eb.fn.countAll<string>().as('c'))
            .where('userId', '=', userId)
            .executeTakeFirst()
        )?.c ?? 0
      ),
    limit
  );
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
