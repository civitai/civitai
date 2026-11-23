import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { createHash } from 'crypto';
import { heldImageSql, unreadableImageSql } from '@civitai/shared/held-media';
import { retractedAccessColumnsSql } from '@civitai/shared/retracted-media-tier';
import {
  imageRoutesHeld,
  newReviewBatchId,
  REVIEW_BATCH_TTL_SECONDS,
  REVIEW_MEDIA_ORIGIN,
  reviewBatchHash,
  reviewBatchLink,
  type ImageSignalRow,
  type ReviewBatchRecord,
  type ReviewTier,
} from '@civitai/shared/review-batch';
import { createScannerReader } from '@civitai/shared/media-signals';
import { env } from '~/env/server';
import { sessionClient } from '~/server/auth/session-client';
import { clickhouse } from '~/server/clickhouse/client';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { fetchTimeoutSignal } from '~/server/utils/fetch-timeout';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { getFeatureFlags } from '~/server/services/feature-flags.service';

import type { SessionUser } from '~/types/session';
import { batchKey, deleteBatch, keySetKey, reviewBatchCall } from './review-batch.store';
import { blockedForPatterns } from '~/server/services/blocked-for-patterns';

/** Longer than any mint takes, so a lock only outlives a crashed one. */
const IDEMPOTENCY_LOCK_SECONDS = 120;

const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');
const idemKey = (keyId: number, key: string) =>
  `${REDIS_KEYS.APP.REVIEW_BATCH_IDEM}:${keyId}:${sha256(key)}` as const;
const idemLockKey = (keyId: number, key: string) =>
  `${REDIS_KEYS.APP.REVIEW_BATCH_IDEM_LOCK}:${keyId}:${sha256(key)}` as const;

export const holdsHeldGrant = (user: SessionUser) => !!getFeatureFlags({ user }).csamReports;

/** Each image's Postgres signals, read on the primary so a report filed a moment ago counts. */
export async function readImageSignals(ids: number[]): Promise<Map<number, ImageSignalRow>> {
  const access = retractedAccessColumnsSql('i', { csamReview: false });
  const rows = await dbWrite.$queryRaw<ImageSignalRow[]>`
    SELECT i.id, ${Prisma.raw(access.restricted)} AS restricted, ${Prisma.raw(
    access.siblings
  )} AS siblings,
      ${Prisma.raw(unreadableImageSql('i'))} AS unreadable,
      COALESCE(${Prisma.raw(heldImageSql('i'))}, false) AS held, i."blockedFor"
    FROM "Image" i
    WHERE i.id IN (${Prisma.join(ids)})
  `;
  return new Map(rows.map((row) => [row.id, row]));
}

/** The scanner's CSAM verdicts (`createScannerReader`); null when ClickHouse cannot answer in time. */
export const { readScannerCsamVerdict, readScannerCsamVerdicts } = createScannerReader(
  () => clickhouse,
  {
    onError: (e) =>
      void logToAxiom({
        name: 'review-batch-scanner-read-failed',
        type: 'warning',
        message: (e as Error).message,
      }),
    deadline: fetchTimeoutSignal,
  }
);

/** Whether the batch is declared suspect: by its minter, or by having no source card. */
export function isDeclared(input: { suspect: boolean; source: string }) {
  return input.suspect || !input.source.trim();
}

/**
 * Held when the batch is declared, the patterns are missing, the scanner cannot be read, or any image
 * is CSAM-restricted, unfinished or gone. An image with no scanner rows routes general.
 */
export async function routeBatch(ids: number[], declared: boolean): Promise<ReviewTier> {
  const patterns = blockedForPatterns();
  if (declared || !patterns) return 'held';
  const [signals, verdicts] = await Promise.all([
    readImageSignals(ids),
    readScannerCsamVerdicts(ids),
  ]);
  if (!verdicts) return 'held';
  // Every image's url siblings in one scanner read, not one read per image.
  const siblingIds = [
    ...new Set([...signals.values()].flatMap((row) => row.siblings.map((s) => s.id))),
  ];
  const siblingVerdicts = await readScannerCsamVerdicts(siblingIds);
  if (!siblingVerdicts) return 'held';
  for (const id of ids) {
    const held = await imageRoutesHeld(signals.get(id), {
      patterns,
      verdict: verdicts.get(id) ?? null,
      readVerdicts: async () => siblingVerdicts,
    });
    if (held) return 'held';
  }
  return 'general';
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
    const taken = await reviewBatchCall('mint.lock', () =>
      redis.set(lock, '1', { NX: true, EX: IDEMPOTENCY_LOCK_SECONDS })
    );
    if (!taken)
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'A mint with this idempotency key is in progress',
      });
  }
  try {
    if (input.idempotencyKey) {
      const idem = idemKey(keyId, input.idempotencyKey);
      const previous = await reviewBatchCall('mint.previous', () => redis.get(idem));
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
    // One key per write (each MULTI is on one key): the key's set entry before the batch, so a
    // batch that opens can always be revoked with its key; then the idempotency record.
    await reviewBatchCall('mint.keySet', () =>
      redis
        .multi()
        .sAdd(keySetKey(keyId), hash)
        .expire(keySetKey(keyId), REVIEW_BATCH_TTL_SECONDS)
        .exec()
    );
    await reviewBatchCall('mint.batch', () =>
      redis.set(batchKey(hash), JSON.stringify(record), { EX: REVIEW_BATCH_TTL_SECONDS })
    );
    const idempotencyKey = input.idempotencyKey;
    if (idempotencyKey)
      await reviewBatchCall('mint.idempotency', () =>
        redis.set(idemKey(keyId, idempotencyKey), hash, { EX: REVIEW_BATCH_TTL_SECONDS })
      );

    return {
      batchId,
      tier,
      link: reviewBatchLink(tier, batchId, env.REVIEW_SHEET_ORIGIN ?? REVIEW_MEDIA_ORIGIN),
    };
  } finally {
    if (lock) await reviewBatchCall('mint.unlock', () => redis.del(lock)).catch(() => null);
  }
}
