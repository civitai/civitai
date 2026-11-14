import { TRPCError } from '@trpc/server';
import type { ConsumerBlobPresignResponse } from '@civitai/orchestration-client';
import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { getConsumerBlobUploadUrlService } from '~/server/services/orchestrator/consumerBlobUpload';
import {
  MEDIA_UPLOAD_BATCH_DAILY_BYTES,
  MEDIA_UPLOAD_BATCH_DAILY_ITEMS,
  MEDIA_UPLOAD_BATCH_RETENTION_MS,
  MEDIA_UPLOAD_BATCH_UNAVAILABLE_ERROR,
  mediaUploadBatchQuotaError,
} from '~/shared/constants/media-upload-batch.constants';

/**
 * The server half of `OPEN_MEDIA_UPLOAD_BATCH`: an App Block uploads many files the viewer
 * confirmed in host chrome, as PRIVATE consumer blobs in the viewer's own account.
 *
 *   1. `startMediaUploadBatch` — after the viewer confirms: charges the viewer's UTC-day quota for
 *      every file, then writes the audit row (`app_block_upload_batches`).
 *   2. `presignMediaUploadBatchItem` — one per upload attempt: mints the upload URL with the
 *      VIEWER's orchestrator token, so every file is the viewer's own upload. Only for a
 *      batch of this viewer and app, while it is open, and at most three times per declared
 *      file, counted by the file's position (`presign_counts`).
 *   3. `recordMediaUploadBatchItem` — one per uploaded file: appends its blob key to the row, at
 *      most one key per file.
 *   3b. Recording is idempotent: a key already in the row is success again, so a retried record
 *      whose first answer was lost is not refused.
 *
 * The quota is charged in full by `startMediaUploadBatch`, before any URL exists, and the presign
 * in step 2 is bounded per file the batch declared, so a batch cannot upload more files than it
 * was charged for. The byte half of the quota is charged on the sizes the host DECLARES (the bytes
 * go straight to the orchestrator, whose own per-file limits apply); the server does not measure
 * them.
 *
 * The record step checks a key's shape and the batch's count, not that the key came from one of
 * this batch's URLs: an upload URL carries no blob key (the upload assigns it), so there is nothing
 * to match it against when the URL is minted.
 *
 * EXPIRY: nothing here pins a file's expiry (the orchestrator exposes no endpoint for it), so each
 * file keeps the orchestrator's default consumer-blob retention, at least 30 days. The row records
 * `expires_at` = start + `MEDIA_UPLOAD_BATCH_RETENTION_MS` as that lower bound, not as a deletion
 * time.
 */

/**
 * Upload URLs one file may take: its first try, the client's one upload retry, and one spare for a
 * presign whose URL was minted but whose answer never reached the client (a dropped connection or a
 * proxy timeout), which the client then presigns again.
 */
export const MEDIA_UPLOAD_BATCH_PRESIGNS_PER_ITEM = 3;
/** How long after it starts a batch may still mint URLs and record files. */
export const MEDIA_UPLOAD_BATCH_OPEN_MS = 6 * 60 * 60 * 1000;
/** The quota counters' lifetime: past the end of their UTC day. */
const QUOTA_KEY_TTL_S = 2 * 24 * 60 * 60;
/**
 * A consumer blob key as the orchestrator returns it. Checked so a key can only ever be one path
 * segment where a moderator view interpolates it.
 */
export const MEDIA_UPLOAD_BATCH_BLOB_KEY_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/;

export type MediaUploadBatchActor = {
  userId: number;
  appBlockId: string;
  appId: string;
  blockId: string;
};

export type MediaUploadBatchItem = { kind: 'image' | 'video' | 'audio'; sizeBytes: number };

function unavailable(): TRPCError {
  return new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: MEDIA_UPLOAD_BATCH_UNAVAILABLE_ERROR,
  });
}

/**
 * A permission error naming the audit table or its id sequence: the table is applied but this
 * environment has not granted it yet. Matched on the message, which names the object, so a
 * permission error on any OTHER table is not mistaken for it.
 */
function isUngrantedBatchTable(err: unknown): boolean {
  const e = err as {
    code?: unknown;
    meta?: { code?: unknown; message?: unknown };
    message?: unknown;
  };
  const text = [e?.message, e?.meta?.message].filter((m) => typeof m === 'string').join(' ');
  return /permission denied for (?:table|relation|sequence) "?app_block_upload_batches(?:_id_seq)?"?/i.test(
    text
  );
}

/**
 * Rethrows an audit table this environment cannot use yet — absent, or applied but not granted —
 * as the not-available refusal, never as a 500.
 */
async function rethrowMissingTable(err: unknown): Promise<never> {
  const { isMissingTableError } = await import('~/server/services/blocks/app-access.service');
  if (isMissingTableError(err) || isUngrantedBatchTable(err)) throw unavailable();
  throw err;
}

/**
 * Charges `items` files and `bytes` bytes against the viewer's UTC-day quota, refusing past either.
 * Fails closed: if a counter can't be written, nothing is charged and the batch is refused. Returns
 * a release for a batch that did not start.
 */
export async function reserveMediaUploadBatchQuota(
  userId: number,
  items: number,
  bytes: number,
  now: Date = new Date()
): Promise<() => Promise<void>> {
  const day = now.toISOString().slice(0, 10);
  const base = REDIS_SYS_KEYS.BLOCKS.MEDIA_UPLOAD_BATCH_DAILY;
  const itemsKey = `${base}:items:${userId}:${day}` as const;
  const bytesKey = `${base}:bytes:${userId}:${day}` as const;
  const charged: Array<[typeof itemsKey | typeof bytesKey, number]> = [];
  const release = async () => {
    for (const [key, amount] of charged) {
      try {
        await sysRedis.decrBy(key, amount);
      } catch {
        // Best-effort: a counter left high refuses early, never admits more.
      }
    }
  };
  let itemTotal: number;
  let byteTotal: number;
  try {
    itemTotal = await sysRedis.incrBy(itemsKey, items);
    charged.push([itemsKey, items]);
    if (itemTotal === items) await sysRedis.expire(itemsKey, QUOTA_KEY_TTL_S);
    byteTotal = await sysRedis.incrBy(bytesKey, bytes);
    charged.push([bytesKey, bytes]);
    if (byteTotal === bytes) await sysRedis.expire(bytesKey, QUOTA_KEY_TTL_S);
  } catch (err) {
    await release();
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Batch uploads are unavailable right now, please try again shortly.',
      cause: err,
    });
  }
  if (itemTotal > MEDIA_UPLOAD_BATCH_DAILY_ITEMS || byteTotal > MEDIA_UPLOAD_BATCH_DAILY_BYTES) {
    await release();
    throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: mediaUploadBatchQuotaError() });
  }
  return release;
}

/** Charges the quota and writes the audit row. The quota is released if the row is not written. */
export async function startMediaUploadBatch({
  actor,
  items,
  now = new Date(),
}: {
  actor: MediaUploadBatchActor;
  items: MediaUploadBatchItem[];
  now?: Date;
}): Promise<{ batchId: number; expiresAt: Date }> {
  const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
  const release = await reserveMediaUploadBatchQuota(actor.userId, items.length, totalBytes, now);
  const expiresAt = new Date(now.getTime() + MEDIA_UPLOAD_BATCH_RETENTION_MS);
  try {
    const app = await dbRead.appBlock.findUnique({
      where: { id: actor.appBlockId },
      select: { version: true },
    });
    const row = await dbWrite.appBlockUploadBatch.create({
      data: {
        userId: actor.userId,
        appBlockId: actor.appBlockId,
        appId: actor.appId,
        blockId: actor.blockId,
        version: app?.version ?? null,
        itemCount: items.length,
        presignCounts: items.map(() => 0),
        totalBytes: BigInt(totalBytes),
        createdAt: now,
        expiresAt,
      },
      select: { id: true },
    });
    return { batchId: row.id, expiresAt };
  } catch (err) {
    await release();
    return rethrowMissingTable(err);
  }
}

/**
 * One upload URL for the file at `index` (its position among the files the batch declared) of an
 * open batch of this viewer and app, minted with `token` — the VIEWER's orchestrator token, never a
 * system client: the files are the viewer's, uploaded as theirs and checked as any upload of theirs
 * is. At most `MEDIA_UPLOAD_BATCH_PRESIGNS_PER_ITEM` per file.
 */
export async function presignMediaUploadBatchItem({
  actor,
  batchId,
  index,
  token,
  now = new Date(),
}: {
  actor: Pick<MediaUploadBatchActor, 'userId' | 'appBlockId'>;
  batchId: number;
  index: number;
  token: string;
  now?: Date;
}): Promise<ConsumerBlobPresignResponse> {
  const openSince = new Date(now.getTime() - MEDIA_UPLOAD_BATCH_OPEN_MS);
  // Postgres arrays are 1-based; `presign_counts` holds one counter per declared file.
  const slot = index + 1;
  const claimed = await dbWrite.$queryRaw<{ id: number }[]>`
      UPDATE "app_block_upload_batches"
      SET "presign_count" = "presign_count" + 1,
          "presign_counts"[${slot}::int] = COALESCE("presign_counts"[${slot}::int], 0) + 1
      WHERE "id" = ${batchId}
        AND "user_id" = ${actor.userId}
        AND "app_block_id" = ${actor.appBlockId}
        AND "created_at" > ${openSince}
        AND ${index}::int >= 0
        AND ${index}::int < "item_count"
        AND COALESCE("presign_counts"[${slot}::int], 0) < ${MEDIA_UPLOAD_BATCH_PRESIGNS_PER_ITEM}::int
      RETURNING "id"`.catch(rethrowMissingTable);
  if (claimed.length === 0) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'this batch cannot take more uploads' });
  }
  try {
    return await getConsumerBlobUploadUrlService({ token });
  } catch (err) {
    // No URL was minted, so the file's attempt is handed back: an upstream outage the client
    // retries through must not use up the file's budget.
    await dbWrite.$executeRaw`
      UPDATE "app_block_upload_batches"
      SET "presign_count" = "presign_count" - 1,
          "presign_counts"[${slot}::int] = "presign_counts"[${slot}::int] - 1
      WHERE "id" = ${batchId} AND "presign_counts"[${slot}::int] > 0`.catch(() => undefined);
    throw err;
  }
}

/** Appends an uploaded file's blob key to its batch's audit row: one key per file, no repeats. */
export async function recordMediaUploadBatchItem({
  actor,
  batchId,
  blobKey,
  now = new Date(),
}: {
  actor: Pick<MediaUploadBatchActor, 'userId' | 'appBlockId'>;
  batchId: number;
  blobKey: string;
  now?: Date;
}): Promise<{ expiresAt: Date }> {
  if (!MEDIA_UPLOAD_BATCH_BLOB_KEY_RE.test(blobKey)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'invalid blob key' });
  }
  const openSince = new Date(now.getTime() - MEDIA_UPLOAD_BATCH_OPEN_MS);
  const rows = await dbWrite.$queryRaw<{ expires_at: Date }[]>`
      UPDATE "app_block_upload_batches"
      SET "blob_keys" = array_append("blob_keys", ${blobKey})
      WHERE "id" = ${batchId}
        AND "user_id" = ${actor.userId}
        AND "app_block_id" = ${actor.appBlockId}
        AND "created_at" > ${openSince}
        AND cardinality("blob_keys") < "item_count"
        AND NOT (${blobKey} = ANY("blob_keys"))
      RETURNING "expires_at"`.catch(rethrowMissingTable);
  if (rows.length > 0) return { expiresAt: rows[0].expires_at };
  // Idempotent: a key this batch already holds (a retried record whose first answer was lost) is
  // success again, with the same answer. Same batch, viewer and app.
  const recorded = await dbWrite.$queryRaw<{ expires_at: Date }[]>`
      SELECT "expires_at" FROM "app_block_upload_batches"
      WHERE "id" = ${batchId}
        AND "user_id" = ${actor.userId}
        AND "app_block_id" = ${actor.appBlockId}
        AND ${blobKey} = ANY("blob_keys")`.catch(rethrowMissingTable);
  if (recorded.length > 0) return { expiresAt: recorded[0].expires_at };
  throw new TRPCError({ code: 'FORBIDDEN', message: 'this batch cannot record more files' });
}
