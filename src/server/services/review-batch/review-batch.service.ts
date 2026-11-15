import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { createHash } from 'crypto';
import { reviewSuspectImageSql, unreadableImageSql } from '@civitai/shared/held-media';
import {
  imageAuditContentHash,
  imageRoutesHeld,
  newReviewBatchId,
  parseBlockedForPatterns,
  REVIEW_BATCH_TTL_SECONDS,
  REVIEW_MEDIA_ORIGIN,
  reviewBatchHash,
  reviewBatchLink,
  SCANNER_HITS_SQL,
  scannerHeldIds,
  type ImageSignalRow,
  type ReviewBatchRecord,
  type ReviewTier,
} from '@civitai/shared/review-batch';
import { env } from '~/env/server';
import { sessionClient } from '~/server/auth/session-client';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { getFeatureFlags } from '~/server/services/feature-flags.service';

import type { SessionUser } from '~/types/session';
import { batchKey, deleteBatch, keySetKey } from './review-batch.store';

const CLICKHOUSE_TIMEOUT_SECONDS = 3;
/** Longer than any mint takes, so a lock only outlives a crashed one. */
const IDEMPOTENCY_LOCK_SECONDS = 120;

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');
const idemKey = (keyId: number, key: string) =>
  `${REDIS_SYS_KEYS.APP.REVIEW_BATCH_IDEM}:${keyId}:${sha256(key)}` as const;
const idemLockKey = (keyId: number, key: string) =>
  `${REDIS_SYS_KEYS.APP.REVIEW_BATCH_IDEM_LOCK}:${keyId}:${sha256(key)}` as const;

export const holdsHeldGrant = (user: SessionUser) => !!getFeatureFlags({ user }).csamReports;

/** Each image's Postgres signals, read on the primary so a report filed a moment ago counts. */
export async function readImageSignals(ids: number[]): Promise<Map<number, ImageSignalRow>> {
  const rows = await dbWrite.$queryRaw<ImageSignalRow[]>`
    SELECT i.id, ${Prisma.raw(reviewSuspectImageSql('i'))} AS suspect,
      ${Prisma.raw(unreadableImageSql('i'))} AS unreadable, i."blockedFor"
    FROM "Image" i
    WHERE i.id IN (${Prisma.join(ids)})
  `;
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The ids the scanner's ClickHouse rows mark CSAM or minor, or that have no rows yet; a completed,
 * unblocked scan stores its minor verdict nowhere else. Null when ClickHouse cannot answer in time:
 * the caller holds every image.
 */
export async function readScannerHits(
  ids: number[],
  { absentHolds = true } = {}
): Promise<Set<number> | null> {
  if (!clickhouse) return null;
  const abort = AbortSignal.timeout((CLICKHOUSE_TIMEOUT_SECONDS + 1) * 1000);
  try {
    const result = await clickhouse.query({
      query: SCANNER_HITS_SQL,
      query_params: { hashes: ids.map(imageAuditContentHash) },
      format: 'JSONEachRow',
      abort_signal: abort,
      clickhouse_settings: { max_execution_time: CLICKHOUSE_TIMEOUT_SECONDS },
    });
    return scannerHeldIds(
      ids,
      await result.json<{ contentHash: string; hit: number }>(),
      absentHolds
    );
  } catch (e) {
    void logToAxiom({
      name: 'review-batch-scanner-read-failed',
      type: 'warning',
      message: (e as Error).message,
    }).catch(() => null);
    return null;
  }
}

let patternsRaw: string | undefined;
let patterns: ReturnType<typeof parseBlockedForPatterns> = null;
function blockedForPatterns() {
  if (env.REVIEW_SHEET_BLOCKEDFOR_PATTERNS !== patternsRaw) {
    patternsRaw = env.REVIEW_SHEET_BLOCKEDFOR_PATTERNS;
    patterns = parseBlockedForPatterns(patternsRaw);
  }
  return patterns;
}

/** Whether the batch is declared suspect: by its minter, or by having no source card. */
export function isDeclared(input: { suspect: boolean; source: string }) {
  return input.suspect || !input.source.trim();
}

/** Held when the batch is declared or any image has, or cannot be shown not to have, a signal. */
export async function routeBatch(ids: number[], declared: boolean): Promise<ReviewTier> {
  if (declared || !blockedForPatterns()) return 'held';
  const [signals, scannerHits] = await Promise.all([readImageSignals(ids), readScannerHits(ids)]);
  if (!scannerHits) return 'held';
  const patternList = blockedForPatterns();
  const anyHeld = ids.some(
    (id) => scannerHits.has(id) || imageRoutesHeld(signals.get(id), patternList)
  );
  return anyHeld ? 'held' : 'general';
}

export type MintInput = {
  ids: number[];
  viewer: number;
  suspect: boolean;
  source: string;
  seat?: string;
  idempotencyKey?: string;
};

export async function mintReviewBatch(
  input: MintInput,
  ctx: { actor: SessionUser; apiKeyId: number | null }
): Promise<{ batchId: string; tier: ReviewTier; link: string }> {
  if (!(await isFlipt(FLIPT_FEATURE_FLAGS.REVIEW_BATCHES_MINT)))
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Review batches are switched off',
    });
  if (!holdsHeldGrant(ctx.actor)) throw new TRPCError({ code: 'FORBIDDEN', message: 'Forbidden' });
  const keyId = ctx.apiKeyId;
  if (keyId == null)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Mint with a personal API key' });

  const viewer = (await sessionClient.getSessionUserById(input.viewer)) as SessionUser | null;
  if (!viewer?.isModerator || viewer.bannedAt || !holdsHeldGrant(viewer))
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'The viewer cannot open review batches' });

  const lock = input.idempotencyKey ? idemLockKey(keyId, input.idempotencyKey) : null;
  if (lock) {
    const taken = await sysRedis.set(lock, '1', { NX: true, EX: IDEMPOTENCY_LOCK_SECONDS });
    if (!taken)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'A mint with this idempotency key is in progress',
      });
  }
  try {
    if (input.idempotencyKey) {
      const previous = await sysRedis.get(idemKey(keyId, input.idempotencyKey));
      if (previous) await deleteBatch(previous, keyId);
    }

    const ids = [...new Set(input.ids)];
    const declared = isDeclared(input);
    const tier = await routeBatch(ids, declared);
    const batchId = newReviewBatchId();
    const hash = reviewBatchHash(batchId);
    const record: ReviewBatchRecord = {
      ids,
      tier,
      declared,
      viewer: viewer.id,
      createdBy: ctx.actor.id,
      keyId,
      seat: input.seat ?? null,
      createdAt: Date.now(),
    };
    const multi = sysRedis
      .multi()
      .set(batchKey(hash), JSON.stringify(record), { EX: REVIEW_BATCH_TTL_SECONDS })
      .sAdd(keySetKey(keyId), hash)
      .expire(keySetKey(keyId), REVIEW_BATCH_TTL_SECONDS);
    if (input.idempotencyKey)
      multi.set(idemKey(keyId, input.idempotencyKey), hash, { EX: REVIEW_BATCH_TTL_SECONDS });
    await multi.exec();

    return {
      batchId,
      tier,
      link: reviewBatchLink(tier, batchId, env.REVIEW_SHEET_ORIGIN ?? REVIEW_MEDIA_ORIGIN),
    };
  } finally {
    if (lock) await sysRedis.del(lock).catch(() => null);
  }
}
