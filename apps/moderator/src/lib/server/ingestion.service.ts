import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from './db';
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

// Images stuck in 'Pending' ingestion within the last 5 days (mirrors the main app's
// getImagesPendingIngestion). Read-only.
export async function getImagesPendingIngestion(): Promise<PendingIngestionImage[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 5);

  return dbRead
    .selectFrom('Image')
    .select(['id', 'name', 'url', 'type', 'createdAt', 'metadata'])
    .where('ingestion', '=', 'Pending')
    .where('createdAt', '>', cutoff)
    .orderBy('id', 'desc')
    .execute();
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

// Images that errored during ingestion and have no derived nsfwLevel yet — the review queue. Keyset
// cursor on id, newest first, within a 1h–2d age window (mirrors the main app's getIngestionErrorImages).
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

// Moderator resolves an ingestion error by pinning the image's nsfwLevel and marking it Scanned. Runs
// INTERNALLY via Kysely (nsfwLevel setter). The one main-app hit is the Meilisearch enqueue. Redis
// cache refreshes are deferred to Wave 3.
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

  // Roll the change up to the post's nsfwLevel (DB function, same as the main app's updatePostNsfwLevel).
  // Cast the bound array to int[] — Postgres infers a bare `ARRAY[$1]` param array as text[], which
  // wouldn't match the function's int[] signature.
  if (image.postId != null)
    await sql`SELECT update_post_nsfw_levels(ARRAY[${image.postId}]::int[])`.execute(dbWrite);

  // Keep the image search indexes in sync — the one sanctioned main-app call.
  void syncSearchIndex({ entityType: 'image', entityId: id, action: 'update' });

  await recordModActivity({ userId, entityType: 'image', entityId: id, activity: 'setNsfwLevel' });

  // TODO(moderator-migration): the main app also refreshes imageMetadataCache + tagIdsForImagesCache
  // (Redis) here; deferred until Redis is wired in the spoke (Wave 3).
}
