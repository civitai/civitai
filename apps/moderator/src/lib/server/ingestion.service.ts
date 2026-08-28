import { sql } from '@civitai/db/kysely';
import { REDIS_KEYS } from '@civitai/redis';
import {
  assertMediaPresentForPublish,
  IMAGE_SCAN_FAILURE_CLASS_PERMANENT,
  isProbeableMediaKey,
  MediaPresence,
} from '@civitai/shared';
import { dbRead, dbWrite } from './db';
import { bustCachedObject } from './cache';
import { syncSearchIndex } from './search-index';
import { recordModActivity } from './mod-activity';
import { getMediaProbeStorage } from './storage';
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

/**
 * The window + state every ingestion-error queue on this page shares. Split out so the two views
 * below can differ in exactly ONE predicate — whether the scan failed permanently — and cannot
 * drift in the window, the ingestion state, or the level bound.
 */
const ingestionErrorBaseWhere = sql`
  i."createdAt" > now() - INTERVAL '2 days'
  AND i."createdAt" < now() - INTERVAL '1 hour'
  AND i.ingestion = 'Error'::"ImageIngestionStatus"
  AND i."nsfwLevel" = 0
`;

/**
 * The scan pipeline's own stored classification of an unfetchable/undecodable input.
 *
 * 🔴 Deliberately NOT a match on the scanner's reason text HERE. A `reason ILIKE '%download%'`
 * predicate in this query would be a spelled guard: one scanner reword and every permanently-broken
 * image walks back into the review queue, silently, at query time.
 *
 * Being honest about what that does and does not buy: the stored CLASS is a fixed enum, but the
 * classification that produces it is itself a substring match on the scanner's prose, one layer up
 * in `image-scan-failure.ts`. So a reword still moves images between these two queues — it just
 * does so at SCAN time, on new rows, where it is visible in that module's own tests, rather than
 * silently re-partitioning every historical row the next time this query runs.
 *
 * `IS [NOT] DISTINCT FROM` rather than `= / <>`: the JSON path yields NULL for an image with no
 * stored scan error at all, and `NULL <> 'permanent'` is NULL — which a WHERE treats as false, so a
 * plain `<>` would silently drop every image whose failure was never classified out of the review
 * queue. Those are exactly the ordinary failures moderators are here to clear.
 */
const permanentScanFailure = sql`
  i."scanJobs"->'error'->>'failureClass' IS NOT DISTINCT FROM ${IMAGE_SCAN_FAILURE_CLASS_PERMANENT}
`;

/**
 * The human review queue: ingestion errors a moderator can still usefully rate — i.e. everything
 * whose scan failure was NOT permanent (timeouts, container churn, unclassified failures). Images
 * whose media can never be fetched are routed to the missing-media view instead, because rating one
 * publishes a permanent 404.
 *
 * Shared by the queue and its badge: a divergence here is a count that never reaches zero.
 */
const ingestionErrorWhere = sql`
  ${ingestionErrorBaseWhere}
  AND NOT (${permanentScanFailure})
`;

/**
 * The complement, over the same window: ingestion errors whose media the scanner could never fetch
 * or decode. Same shared-const discipline — `getMissingMediaImages` and `countMissingMediaImages`
 * both read this one value, so the page and its badge cannot disagree.
 *
 * Together with `ingestionErrorWhere` this is an exact partition of `ingestionErrorBaseWhere`: no
 * image in the window is in both views, and none is in neither.
 */
const missingMediaWhere = sql`
  ${ingestionErrorBaseWhere}
  AND ${permanentScanFailure}
`;

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
    WHERE ${ingestionErrorWhere}
      AND (${cursor != null ? sql`i.id < ${cursor}` : sql`TRUE`})
    ORDER BY i."createdAt" DESC
    LIMIT ${limit + 1}
  `.execute(dbRead);

  const items = result.rows;
  let nextCursor: number | undefined;
  if (items.length > limit) nextCursor = items.pop()?.id;

  return { items, nextCursor };
}

/** The badge for `/images/ingestion-errors` — same window and predicates as the queue, or the count
 *  never reaches zero on a page that has been drained. */
export async function countIngestionErrorImages(): Promise<number> {
  const result = await sql<{ count: string }>`
    SELECT count(*) AS count
    FROM "Image" i
    WHERE ${ingestionErrorWhere}
  `.execute(dbRead);
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * The missing-media view: same window, opposite side of the `failureClass` split. These images are
 * NOT rateable — their file can never be fetched, so the only useful affordance is deleting them.
 */
export async function getMissingMediaImages({
  limit,
  cursor,
}: {
  limit: number;
  cursor?: number;
}): Promise<{ items: IngestionErrorImage[]; nextCursor?: number }> {
  const result = await sql<IngestionErrorImage>`
    SELECT i.id, i.url, i.name, i."nsfwLevel", i.type, i.width, i.height, i."createdAt"
    FROM "Image" i
    WHERE ${missingMediaWhere}
      AND (${cursor != null ? sql`i.id < ${cursor}` : sql`TRUE`})
    ORDER BY i."createdAt" DESC
    LIMIT ${limit + 1}
  `.execute(dbRead);

  const items = result.rows;
  let nextCursor: number | undefined;
  if (items.length > limit) nextCursor = items.pop()?.id;

  return { items, nextCursor };
}

/**
 * Is this image actually in the missing-media set right now?
 *
 * The page's delete action takes an id off a form, and deleting an image is permanent and
 * cascading (row + stored object + de-index). Re-selecting through the SAME shared predicate is
 * what keeps the action scoped to what the page shows, instead of turning a moderator route into an
 * arbitrary delete-by-id. Uses `missingMediaWhere`, so it cannot drift from the queue or its badge.
 */
export async function isMissingMediaImage(id: number): Promise<boolean> {
  const result = await sql<{ id: number }>`
    SELECT i.id
    FROM "Image" i
    WHERE ${missingMediaWhere}
      AND i.id = ${id}
    LIMIT 1
  `.execute(dbRead);
  return result.rows.length > 0;
}

/** The badge for `/images/missing-media` — same shared const as its queue, for the same reason. */
export async function countMissingMediaImages(): Promise<number> {
  const result = await sql<{ count: string }>`
    SELECT count(*) AS count
    FROM "Image" i
    WHERE ${missingMediaWhere}
  `.execute(dbRead);
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Ask the media store whether an image's object is actually there, as a three-valued answer.
 *
 * The storage client resolves `{ exists }` on a definitive answer and THROWS on anything else — a
 * transport failure, a 5xx, a rotated credential, an unconfigured endpoint. That last shape is why
 * the client is built inside the probe rather than at module scope: every one of them has to land
 * on `unknown` and allow, and `assertMediaPresentForPublish` runs this inside its own try.
 *
 * Every image lives in the `b2Image` backend — the same assumption the image-deletion path makes,
 * where `Image.url` is passed straight through as the object key.
 */
async function probeImageMediaPresence(url: string) {
  // 🔴 Not every `Image.url` is a bucket key — see `isProbeableMediaKey`. This is also what keeps
  // the two runtimes agreeing: their storage clients fail DIFFERENTLY on a non-key url (the main
  // app's 404s to `absent`; this one throws on an empty parsed bucket to `unknown`), so deciding it
  // here rather than in each probe is the difference between one rule and two.
  if (!isProbeableMediaKey(url)) return MediaPresence.Unknown;
  const { exists } = await getMediaProbeStorage().headObject({ backend: 'b2Image', key: url });
  return exists ? MediaPresence.Present : MediaPresence.Absent;
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
    .select(['postId', 'metadata', 'url'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!image) throw new Error('Image not found');

  /**
   * 🔴 REFUSE TO PUBLISH AN IMAGE WHOSE MEDIA IS GONE.
   *
   * This is the call site that caused the incident. Everything below makes the image visible —
   * `ingestion = 'Scanned'` plus a locked nsfwLevel — and it ran unconditionally, so an image whose
   * file can never be fetched was rated by a human exactly like a scan that merely timed out, and
   * publishing it put a permanent 404 on the site. The `failureClass` split above keeps these off
   * the queue; this is the write-side guard, and it is the authority: the queue predicate is a
   * trigger, an existence check against the store is the verdict.
   *
   * Three-valued and only `absent` refuses — an unconsultable store must not block moderation. The
   * thrown message reaches the moderator verbatim through the action's `fail(400, { error })`.
   */
  await assertMediaPresentForPublish({
    probe: () => probeImageMediaPresence(image.url),
    onUnknown: (error) =>
      console.warn('[ingestion] media probe inconclusive; allowing publish', id, error),
    // The mirror of onUnknown: a wrong bucket name 404s for EVERY key, so a fail-CLOSED
    // misconfiguration would refuse every publish and look exactly like a real run of misses.
    onRefused: () => console.warn('[ingestion] refused publish; media object reported absent', id),
  });

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
