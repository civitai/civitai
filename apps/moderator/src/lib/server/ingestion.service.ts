import { sql } from '@civitai/db/kysely';
import { REDIS_KEYS } from '@civitai/redis';
import { dbRead, dbWrite } from './db';
import { bustCachedObject } from './cache';
import { syncSearchIndex } from './search-index';
import { recordModActivity } from './mod-activity';
import type { MediaType } from '$lib/media/edge-url';

export type PendingIngestionImage = {
  id: number;
  name: string | null;
  url: string;
  type: MediaType;
  createdAt: Date;
  metadata: unknown;
};

const pendingCutoff = () => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 5);
  return cutoff;
};

export async function getImagesPendingIngestion({
  cursor,
  limit,
}: {
  cursor?: number;
  limit: number;
}): Promise<{ items: PendingIngestionImage[]; nextCursor?: number }> {
  const rows = await dbRead
    .selectFrom('Image')
    .select(['id', 'name', 'url', 'type', 'createdAt', 'metadata'])
    .where('ingestion', '=', 'Pending')
    .where('createdAt', '>', pendingCutoff())
    .$if(cursor != null, (qb) => qb.where('id', '<', cursor!))
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .execute();

  let nextCursor: number | undefined;
  if (rows.length > limit) nextCursor = rows.pop()?.id;
  return { items: rows, nextCursor };
}

export async function countImagesPendingIngestion(): Promise<number> {
  const row = await dbRead
    .selectFrom('Image')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('ingestion', '=', 'Pending')
    .where('createdAt', '>', pendingCutoff())
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export type IngestionErrorImage = {
  id: number;
  url: string;
  name: string | null;
  nsfwLevel: number;
  type: MediaType;
  width: number | null;
  height: number | null;
  createdAt: Date;
};

export async function getIngestionErrorImages({
  limit,
  cursor,
}: {
  limit: number;
  cursor?: number;
}): Promise<{ items: IngestionErrorImage[]; nextCursor?: number }> {
  const result = await sql<IngestionErrorImage>`
    SELECT i.id, i.url, i.name, i."nsfwLevel", i.type, i.width, i.height, i."createdAt"
    FROM "Image" i
    WHERE i."createdAt" > now() - INTERVAL '2 days'
      AND i."createdAt" < now() - INTERVAL '1 hour'
      AND i.ingestion = 'Error'::"ImageIngestionStatus"
      AND i."nsfwLevel" = 0
      AND (${cursor != null ? sql`i.id < ${cursor}` : sql`TRUE`})
    ORDER BY i."createdAt" DESC
    LIMIT ${limit + 1}
  `.execute(dbRead);

  const items = result.rows;
  let nextCursor: number | undefined;
  if (items.length > limit) nextCursor = items.pop()?.id;

  return { items, nextCursor };
}

export async function resolveIngestionError({
  id,
  nsfwLevel,
  userId,
}: {
  id: number;
  nsfwLevel: number;
  userId: number;
}): Promise<void> {
  const image = await dbWrite
    .selectFrom('Image')
    .select(['postId', 'metadata'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!image) throw new Error('Image not found');

  const metadata = {
    ...((image.metadata as Record<string, unknown> | null) ?? {}),
    nsfwLevelReason: 'Moderator ingestion error review',
  };

  await dbWrite
    .updateTable('Image')
    .set({
      nsfwLevel,
      nsfwLevelLocked: true,
      ingestion: 'Scanned',
      scannedAt: new Date(),
      metadata: sql`${JSON.stringify(metadata)}::jsonb`,
    })
    .where('id', '=', id)
    .execute();

  // Cast to int[] — Postgres infers a bare `ARRAY[$1]` param array as text[], which won't match the
  // function's int[] signature.
  if (image.postId != null)
    await sql`SELECT update_post_nsfw_levels(ARRAY[${image.postId}]::int[])`.execute(dbWrite);

  void syncSearchIndex({ entityType: 'image', entityId: id, action: 'update' });

  await recordModActivity({ userId, entityType: 'image', entityId: id, activity: 'setNsfwLevel' });

  await Promise.all([
    bustCachedObject(REDIS_KEYS.CACHES.IMAGE_METADATA, id),
    bustCachedObject(REDIS_KEYS.CACHES.TAG_IDS_FOR_IMAGES, id),
  ]);
}
