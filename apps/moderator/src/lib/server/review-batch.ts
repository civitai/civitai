import { sql } from '@civitai/db/kysely';
import { REDIS_SYS_KEYS, type RedisKeyTemplateSys } from '@civitai/redis';
import { suspectImageSql, unreadableImageSql } from '@civitai/shared/held-media';
import {
  imageAuditContentHash,
  imageRoutesHeld,
  isReviewBatchId,
  parseBlockedForPatterns,
  parseReviewBatchRecord,
  reviewBatchHash,
  SCANNER_HITS_SQL,
  scannerHeldIds,
  type ImageSignalRow,
  type ReviewBatchRecord,
  type ReviewTier,
} from '@civitai/shared/review-batch';
import { env } from '$env/dynamic/private';
import { dbWrite } from './db';
import { getClickhouse } from './clickhouse';
import { getSysRedis } from './redis';
import { HELD_MEDIA_PAGE } from './held-media';

/** The page whose grant opens a general batch: the image lookup shows any site image already. */
export const REVIEW_MEDIA_PAGE = '/retool/image-lookup';
export const TIER_PAGE: Record<ReviewTier, string> = {
  held: HELD_MEDIA_PAGE,
  general: REVIEW_MEDIA_PAGE,
};

export type LoadedBatch = ReviewBatchRecord & { hash: string };

const batchKey = (hash: string) =>
  `${REDIS_SYS_KEYS.APP.REVIEW_BATCH}:${hash}` as RedisKeyTemplateSys;

/** The live batch an id names, or null when it is malformed, expired or unreadable. */
export async function getReviewBatch(batchId: string | undefined): Promise<LoadedBatch | null> {
  if (!batchId || !isReviewBatchId(batchId)) return null;
  const hash = reviewBatchHash(batchId);
  return getReviewBatchByHash(hash);
}

export async function getReviewBatchByHash(hash: string): Promise<LoadedBatch | null> {
  const record = parseReviewBatchRecord(await getSysRedis().get(batchKey(hash)));
  return record ? { ...record, hash } : null;
}

/** Whether the API key that minted a batch still exists: a deleted key's batches stop opening even
 *  if the main app's revoke missed one. */
export async function mintingKeyLive(keyId: number): Promise<boolean> {
  const row = await dbWrite
    .selectFrom('ApiKey')
    .select('id')
    .where('id', '=', keyId)
    .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', new Date())]))
    .executeTakeFirst();
  return !!row;
}

/** * Whether the scanner's ClickHouse rows hold an image on the held tier: a CSAM or minor label, or no * rows. A read that fails answers yes, so the general route answers moved and the held route serves. */
 */
export async function scannerHoldsImage(imageId: number): Promise<boolean> {
  try {
    const result = await getClickhouse().query({
      query: SCANNER_HITS_SQL,
      query_params: { hashes: [imageAuditContentHash(imageId)] },
      format: 'JSONEachRow',
      clickhouse_settings: { max_execution_time: 3 },
    });
    return scannerHeldIds([imageId], await result.json()).has(imageId);
  } catch {
    return true;
  }
}

export type BatchMedia = { imageId: number; url: string; type: string; mimeType: string | null };

/**
 * Image `n` of a batch with its signals read again on the primary, or null when `n` is out of range
 * or the image is gone. `held` is whether the image must be on the held tier now.
 */
export async function getBatchMedia(
  batch: ReviewBatchRecord,
  n: number
): Promise<(BatchMedia & { held: boolean }) | null> {
  const imageId = batch.ids[n];
  if (imageId === undefined) return null;
  const row = await dbWrite
    .selectFrom('Image as i')
    .select([
      'i.id',
      'i.url',
      'i.type',
      'i.mimeType',
      'i.blockedFor',
      sql<boolean>`${sql.raw(suspectImageSql('i'))}`.as('suspect'),
      sql<boolean>`${sql.raw(unreadableImageSql('i'))}`.as('unreadable'),
    ])
    .where('i.id', '=', imageId)
    .executeTakeFirst();
  if (!row) return null;
  const signals: ImageSignalRow = {
    id: row.id,
    suspect: row.suspect,
    unreadable: row.unreadable,
    blockedFor: row.blockedFor,
  };
  return {
    imageId: row.id,
    url: row.url,
    type: row.type,
    mimeType: row.mimeType,
    held: imageRoutesHeld(signals, blockedForPatterns()),
  };
}

let patternsRaw: string | undefined;
let patterns: ReturnType<typeof parseBlockedForPatterns> = null;
function blockedForPatterns() {
  const raw = env.REVIEW_SHEET_BLOCKEDFOR_PATTERNS;
  if (raw !== patternsRaw) {
    patternsRaw = raw;
    patterns = parseBlockedForPatterns(raw);
  }
  return patterns;
}
