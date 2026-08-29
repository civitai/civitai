import { sql } from '@civitai/db/kysely';
import { REDIS_KEYS } from '@civitai/redis';
import {
  assertMediaPresentForPublish,
  IMAGE_SCAN_FAILURE_CLASS_PERMANENT,
  MediaPresence,
  summarizeProbeError,
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
 * The window + state the ingestion-error queue selects on, split out from the publishability
 * predicate below so the two cannot drift into each other.
 *
 * The two `createdAt` bounds predate this app — they arrived with the original main-app query in
 * `3575ab0413` and again in the cutover `e4104d5bf1`, in both cases with NO comment — so the reason
 * for the 1-hour lower bound is not recorded anywhere and is not invented here. What matters for
 * the page is the effect: a row younger than an hour, or older than two days, is not listed.
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
 * in the main app's `image-scan-failure.ts`. So a reword still moves images between the two sides —
 * it just does so at SCAN time, on new rows, where it is visible in that module's own tests, rather
 * than silently re-partitioning every historical row the next time this query runs.
 *
 * The string is imported from `@civitai/shared`, not spelled here: the main app WRITES it into
 * `scanJobs.error.failureClass` and this SQL selects on it, across two runtimes that cannot see
 * each other. Two literals that must agree is how they stop agreeing.
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
 * The human review queue: ingestion errors a moderator can still usefully rate — timeouts,
 * container churn, unclassified failures. Images whose media the scanner classified as permanently
 * unfetchable are carved out, because rating one publishes a permanent 404.
 *
 * 🔴 THIS IS A TRIGGER, NOT THE VERDICT, and the two are deliberately different mechanisms. The
 * authority is the write-side guard in `resolveIngestionError` below, which asks the media store
 * whether the object is actually there; a stored failure class is only the best SQL-side correlate
 * of that, and it is a strictly smaller set (a row classified `transient`/`unknown`/NULL whose
 * object really is gone still reaches this queue, and is refused by the guard when a moderator acts
 * on it). Carving them out here is what stops a moderator being handed work they cannot complete;
 * the guard is what stops the 404.
 *
 * 🔴 THE PARENTHESES ARE LOAD-BEARING even with a single conjunct today: `NOT a AND b` and
 * `NOT (a AND b)` differ, so a second predicate added inside without them silently inverts the
 * partition. The queue-partition suite pins the grouping for that reason.
 *
 * Shared by the queue and its badge: a divergence here is a count that never reaches zero.
 */
const ingestionErrorWhere = sql`
  ${ingestionErrorBaseWhere}
  AND NOT ( ${permanentScanFailure} )
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
 * Ask the media store whether an image's object is actually there, as a three-valued answer.
 *
 * The storage client resolves `{ exists }` on a definitive answer and THROWS on anything else — a
 * transport failure, a 5xx, a rotated credential, an unconfigured endpoint. That last shape is why
 * the client is built inside the probe rather than at module scope: every one of them has to land
 * on `unknown` and allow, and `assertMediaPresentForPublish` runs this inside its own try.
 *
 * Every image lives in the `b2Image` backend — the same assumption the image-deletion path in this
 * app makes, where `Image.url` is passed straight through as the object key.
 *
 * 🔴 `'b2Image'` IS AN ALIAS, NOT A BUCKET — AND IT IS A DIFFERENT SOURCE OF TRUTH FROM THE MAIN
 * APP'S. It is a member of `@civitai/storage`'s wire enum (`packages/civitai-storage/src/schema.ts`)
 * that the `apps/storage` service resolves in its own process
 * (`apps/storage/src/lib/server/backends.ts`) from its own `S3_IMAGE_B2_ENDPOINT` /
 * `S3_IMAGE_B2_BUCKET` — same variable NAMES as the main app's, but a different deployment and a
 * different Secret. The main app's probe resolves through `getImageUploadBackend()`, i.e. the
 * function its uploader uses, so there it cannot ask a different store from the one that wrote the
 * key. Here there is no such function to route through: the two agree today because the two
 * deployments are configured to the same bucket, which is a fact about config, not about code.
 *
 * That matters only if the upload store MOVES, and the two ways it would then break are NOT the
 * same. A live endpoint on the WRONG bucket 404s for every key, i.e. `absent`, which refuses every
 * publish — fail-closed, no broken image reaches the site, but indistinguishable from a real run of
 * misses (the `onRefused` counter below exists for exactly that). An endpoint left UNCONFIGURED
 * instead THROWS, which lands on `unknown`, and `unknown` ALLOWS — the silent direction. Neither is
 * caught by anything in this repo, because both are config.
 *
 * Recorded so the next person moving that store knows this is a third place to change and not a
 * copy of the main app's resolver.
 */
async function probeImageMediaPresence(key: string) {
  // 🔴 No key check here, deliberately. `assertMediaPresentForPublish` classifies the url and only
  // calls this with a value that already passed the SHARED `isProbeableMediaKey`. That is what keeps
  // the two runtimes agreeing: their storage clients fail DIFFERENTLY on a non-key url (the main
  // app's 404s to `absent`; this one throws on an empty parsed bucket to `unknown`), so a copy of
  // the test in each probe is the difference between one rule and two.
  const { exists } = await getMediaProbeStorage().headObject({ backend: 'b2Image', key });
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
   * publishing it put a permanent 404 on the site. The `failureClass` split above keeps most of
   * these off the queue; this is the write-side guard, and it is the authority: the queue predicate
   * is a trigger, an existence check against the store is the verdict.
   *
   * Only `absent` refuses — an unconsultable store must not block moderation, and a url that is not
   * a key this store issues is not asked about at all. The thrown message reaches the moderator
   * verbatim through the page action's `fail(400, { error })`.
   */
  await assertMediaPresentForPublish({
    url: image.url,
    probe: (key) => probeImageMediaPresence(key),
    // 🔴 `summarizeProbeError`, never the raw error. A `StorageClientError` embeds the remote
    // response BODY in its message — unbounded third-party text (an HTML error page, an XML fault)
    // straight into stdout and therefore Loki, once per inconclusive probe.
    onUnknown: ({ reason, error }) =>
      console.warn(
        '[ingestion] media probe inconclusive; allowing publish',
        id,
        reason,
        summarizeProbeError(error)
      ),
    // The mirror of onUnknown: a wrong bucket name 404s for EVERY key, so a fail-CLOSED
    // misconfiguration would refuse every publish and look exactly like a real run of misses.
    onRefused: (presence) =>
      console.warn('[ingestion] refused publish; media cannot be served', id, presence),
    /**
     * 🔴 The short-circuit needs a counter too. `isProbeableMediaKey` is a deliberate
     * UNDER-approximation — it matches only the bare-uuid shape our upload endpoints mint — so it is
     * KNOWN to decline real keys. Without this line a run in which it declines EVERY row emits
     * nothing and is indistinguishable from a run where the guard actually ran.
     */
    onSkipped: () => console.warn('[ingestion] media not probeable; no existence check ran', id),
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
