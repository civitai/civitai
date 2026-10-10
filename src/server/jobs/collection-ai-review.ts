import { Prisma } from '@prisma/client';
import pLimit from 'p-limit';
import {
  CollectionItemRejectionReason,
  CollectionItemStatus,
  ImageIngestionStatus,
} from '~/shared/utils/prisma/enums';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { Tracker } from '~/server/clickhouse/tracker';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { CollectionAiReviewSchema } from '~/server/schema/collection.schema';
import { collectionAiReviewSchema } from '~/server/schema/collection.schema';
import {
  AI_REVIEW_SYSTEM_USER_ID as SYSTEM_USER_ID,
  COLLECTION_AI_REVIEW_KEY_PREFIX,
  updateCollectionItemsStatus,
} from '~/server/services/collection.service';
import {
  decideFromObservations,
  isAiReviewAvailable,
  isNsfwLevelAllowed,
  isUnratedNsfwLevel,
  needsMinorReview,
  resolveRejectionMessage,
  reviewImage,
} from '~/server/services/ai/collection-review.service';
import type { AiReviewDecision } from '~/server/services/ai/collection-review.service';
import { queueImageSearchIndexUpdate } from '~/server/services/image.service';
import { bustCachesForPosts } from '~/server/services/post.service';
import { isDefined } from '~/utils/type-guards';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { createJob } from './job';

// Chunks are barriers waiting on the slowest call (~3s median, 13-20s tail), so they must be wide
// enough to absorb stragglers. Chunk size is also the crash-safety granularity. See the feature doc.
const BATCH_SIZE = 300;
const CHUNK_SIZE = 50;
const CONCURRENCY = 15;

export const MAX_REVIEW_ATTEMPTS = 3;
const ATTEMPTS_TTL_SECONDS = 7 * 24 * 60 * 60;

export const UNAVAILABLE_IMAGE_REJECTION =
  "We couldn't load this image. Try uploading it again and resubmitting.";

type PendingItem = {
  collectionItemId: number;
  imageId: number;
  url: string;
  type: string;
  nsfwLevel: number;
  ingestion: string;
  prompt: string | null;
};

export const collectionAiReview = createJob(
  'collection-ai-review',
  '*/15 * * * *',
  async () => {
    if (!isAiReviewAvailable()) return;

    const rows = await dbRead.$queryRaw<{ key: string; value: unknown }[]>`
      SELECT key, value FROM "KeyValue" WHERE key LIKE ${`${COLLECTION_AI_REVIEW_KEY_PREFIX}%`}
    `;

    for (const row of rows) {
      const collectionId = Number(row.key.split(':')[1]);
      if (!collectionId) continue;

      const parsed = collectionAiReviewSchema.safeParse(row.value);
      if (!parsed.success || !parsed.data.enabled) continue;

      await withDistributedLock(
        // A run that overlaps itself would double-bill and double-notify. maxRetries 0 means a
        // still-running batch is skipped rather than queued behind the lock.
        { key: `collection-ai-review-run:${collectionId}`, ttl: 1800, maxRetries: 0 },
        () => reviewCollection(collectionId, parsed.data)
      );
    }
  },
  { lockExpiration: 1800 }
);

export async function reviewCollection(collectionId: number, config: CollectionAiReviewSchema) {
  // reviewedById marks an item as already seen, so nothing is reclassified — or re-billed — on a
  // later run.
  const pending = await dbWrite.$queryRaw<PendingItem[]>`
    SELECT ci.id "collectionItemId", i.id "imageId", i.url, i.type::text, i."nsfwLevel",
           i.ingestion::text, i.meta->>'prompt' prompt
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    WHERE ci."collectionId" = ${collectionId}
      AND ci.status = 'REVIEW'
      AND ci."reviewedById" IS NULL
    ORDER BY ci.id
    LIMIT ${BATCH_SIZE}
  `;

  // Ingestion has not rated these yet, so there is no level to check them against. Skipped rather
  // than stamped, so they are picked up once they have one. A NotFound image never will be.
  const reviewable = pending.filter(
    (item) => isUnavailableImage(item) || !isUnratedNsfwLevel(item.nsfwLevel)
  );
  if (!reviewable.length) return;

  const tracker = new Tracker();
  const limit = pLimit(CONCURRENCY);

  for (let i = 0; i < reviewable.length; i += CHUNK_SIZE) {
    const chunk = reviewable.slice(i, i + CHUNK_SIZE);
    const outcomes = await Promise.all(
      chunk.map((item) => limit(() => classifyItem({ item, config, collectionId, tracker })))
    );
    await applyOutcomes({ collectionId, outcomes: outcomes.filter(isDefined) });
  }
}

type Outcome = {
  collectionItemId: number;
  imageId: number;
  action: 'accept' | 'reject' | 'stamp';
  message?: string;
  minorReview?: boolean;
};

async function classifyItem({
  item,
  config,
  collectionId,
  tracker,
}: {
  item: PendingItem;
  config: CollectionAiReviewSchema;
  collectionId: number;
  tracker: Tracker;
}): Promise<Outcome | undefined> {
  let decision: AiReviewDecision;
  let reason = '';
  let rejectionMessage: string | undefined;
  let usage = { promptTokens: 0, completionTokens: 0 };

  if (isUnavailableImage(item)) {
    decision = { decision: 'reject', violations: [], escalations: [] };
    reason = 'The image file could not be found.';
    rejectionMessage = UNAVAILABLE_IMAGE_REJECTION;
  } else if (!isNsfwLevelAllowed(item.nsfwLevel, config.allowedNsfwLevels)) {
    decision = { decision: 'reject', violations: ['sexual/adult content'], escalations: [] };
    reason = `Rated outside the levels this collection allows (nsfwLevel ${item.nsfwLevel}).`;
  } else {
    const imageUrl = getEdgeUrl(item.url, {
      width: 512,
      anim: item.type === 'video' ? false : undefined,
      transcode: item.type === 'video' ? true : undefined,
      name: 'image',
    });
    // NEXT_PUBLIC_IMAGE_LOCATION defaults to '' and validates clean when unset, which yields a
    // hostless path the model provider cannot fetch. Bail loudly instead of failing every item.
    if (!/^https?:\/\//.test(imageUrl)) {
      logToAxiom({
        type: 'job-error',
        name: 'collection-ai-review',
        collectionId,
        error: `Non-absolute image url (${imageUrl}); check NEXT_PUBLIC_IMAGE_LOCATION`,
      }).catch(() => undefined);
      return undefined;
    }

    try {
      const result = await reviewImage({
        imageUrl,
        prompt: item.prompt,
        model: config.model,
        systemPrompt: config.prompt,
      });
      if (!result) return undefined;

      ({ usage } = result);
      decision = decideFromObservations(result.observations, { isVideo: item.type === 'video' });
      reason = (result.observations as { reason?: string } | null)?.reason?.slice(0, 500) ?? '';
    } catch (error) {
      const attempts = await recordFailedAttempt(item.collectionItemId);
      logToAxiom({
        type: 'job-error',
        name: 'collection-ai-review',
        collectionId,
        imageId: item.imageId,
        attempts,
        error: (error as Error).message,
      }).catch(() => undefined);
      // Most failures clear on a later run, so the item is left for the next one. Stamped once the
      // attempts run out, so a permanently broken image (the CDN refuses some of them) is not
      // retried, and re-billed, on every run for the life of the collection.
      if (attempts < MAX_REVIEW_ATTEMPTS) return undefined;
      return { collectionItemId: item.collectionItemId, imageId: item.imageId, action: 'stamp' };
    }
  }

  const applied = !config.dryRun;
  let action: Outcome['action'] = 'stamp';
  let message: string | undefined;

  // Escalations flagged neverReject are our own uncertainty, so they go to a human no matter how
  // escalations are configured.
  if (applied && !decision.neverReject) {
    if (decision.decision === 'approve') action = 'accept';
    else if (decision.decision === 'reject' || config.escalationAction === 'reject') {
      action = 'reject';
      message = rejectionMessage ?? resolveRejectionMessage(decision.violations, config.reasonCopy);
    }
  }

  await tracker.collectionAiReview({
    collectionId,
    collectionItemId: item.collectionItemId,
    entityId: item.imageId,
    userId: SYSTEM_USER_ID,
    model: config.model,
    decision: decision.decision,
    // What the rules said and what we did diverge when an escalation is configured to reject, and
    // the applied action is the one an audit needs.
    appliedAction: applied ? action : 'none',
    violations: decision.violations,
    escalations: decision.escalations,
    reason,
    applied,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  });

  return {
    collectionItemId: item.collectionItemId,
    imageId: item.imageId,
    action,
    message,
    minorReview: applied && needsMinorReview(decision),
  };
}

// The scanner could not fetch the file, and nothing rescans a NotFound image on its own.
function isUnavailableImage(item: Pick<PendingItem, 'ingestion'>) {
  return item.ingestion === ImageIngestionStatus.NotFound;
}

// A Redis failure reads as exhausted, so the item is stamped rather than re-billed every run.
export async function recordFailedAttempt(collectionItemId: number) {
  const key = `${REDIS_SYS_KEYS.COLLECTION_AI_REVIEW.ATTEMPTS}:${collectionItemId}` as const;
  try {
    const attempts = await sysRedis.incrBy(key, 1);
    await sysRedis.expire(key, ATTEMPTS_TTL_SECONDS);
    return attempts;
  } catch {
    return MAX_REVIEW_ATTEMPTS;
  }
}

// Keyed on the status alone: an AI rejection with no message is still an AI rejection, and gating
// on the message instead silently persisted no reason at all.
export function resolveAutomatedRejectionReason({
  status,
}: {
  status: CollectionItemStatus;
}): CollectionItemRejectionReason | undefined {
  return status === CollectionItemStatus.REJECTED
    ? CollectionItemRejectionReason.Automated
    : undefined;
}

function logFlagError(collectionId: number, error: string, imageIds?: number[]) {
  logToAxiom({
    type: 'job-error',
    name: 'collection-ai-review',
    collectionId,
    imageIds,
    error,
  }).catch(() => undefined);
}

// Only fills an empty slot. Even the queues minor review outranks are left alone: accepting in the
// minor queue also resolves tag reviews it never shows and can clear the scanner's minor flag, so
// moving an image there could lower it. Rewriting 'minor' with itself counts it as routed.
// Resolves false only when the write itself failed.
export async function flagForMinorReview({
  collectionId,
  imageIds,
}: {
  collectionId: number;
  imageIds: number[];
}) {
  if (!imageIds.length) return true;

  let flagged: { id: number; postId: number | null }[];
  try {
    flagged = await dbWrite.$queryRaw<{ id: number; postId: number | null }[]>`
      UPDATE "Image"
      SET "needsReview" = 'minor', "updatedAt" = now()
      WHERE id IN (${Prisma.join(imageIds)})
        AND ("needsReview" IS NULL OR "needsReview" = 'minor')
        AND ingestion = 'Scanned'
      RETURNING id, "postId"
    `;
  } catch (error) {
    logFlagError(
      collectionId,
      `Failed to flag images for minor review: ${(error as Error).message}`,
      imageIds
    );
    return false;
  }

  // Held in a queue minor review does not outrank, or not scanned: without this the escalation is
  // recorded only in ClickHouse.
  const flaggedIds = new Set(flagged.map((row) => row.id));
  const unrouted = imageIds.filter((id) => !flaggedIds.has(id));
  if (unrouted.length)
    logFlagError(collectionId, 'Minor escalation not routed to the minor queue', unrouted);

  if (!flagged.length) return true;

  const postIds = [...new Set(flagged.map((row) => row.postId).filter(isDefined))];
  await Promise.all([
    queueImageSearchIndexUpdate({
      ids: [...flaggedIds],
      action: SearchIndexUpdateQueueAction.Update,
    }).catch((error) =>
      logFlagError(collectionId, `Search index update failed: ${(error as Error).message}`)
    ),
    bustCachesForPosts(postIds).catch((error) =>
      logFlagError(collectionId, `Post cache bust failed: ${(error as Error).message}`)
    ),
  ]);
  return true;
}

// A rejected item can be deleted within the hour, taking the only trace of the escalation with it,
// so an item whose flag did not land is left for the next run to retry. Out of attempts, it is
// stamped rather than decided: never accepted on the strength of a later, different verdict.
async function holdUnflagged(reviewed: Outcome[], minor: Outcome[]) {
  const retry = new Set<number>();
  const stamp = new Set<number>();
  for (const { collectionItemId } of minor) {
    const attempts = await recordFailedAttempt(collectionItemId);
    (attempts < MAX_REVIEW_ATTEMPTS ? retry : stamp).add(collectionItemId);
  }
  return reviewed
    .filter((o) => !retry.has(o.collectionItemId))
    .map((o) =>
      stamp.has(o.collectionItemId) ? { ...o, action: 'stamp' as const, message: undefined } : o
    );
}

// Stamps before writing status: a status write can throw, and an unstamped item is reselected and
// re-billed on the next run.
async function applyOutcomes({
  collectionId,
  outcomes: reviewed,
}: {
  collectionId: number;
  outcomes: Outcome[];
}) {
  if (!reviewed.length) return;

  const minor = reviewed.filter((o) => o.minorReview);
  const flagged = await flagForMinorReview({
    collectionId,
    imageIds: minor.map((o) => o.imageId),
  });
  const outcomes = flagged ? reviewed : await holdUnflagged(reviewed, minor);
  if (!outcomes.length) return;

  // Minutes can pass between selecting an item and writing its outcome. Claiming the row only
  // while it is still untouched means a moderator who decided it in the meantime keeps their
  // decision and their attribution — and the status write below skips whatever we did not claim.
  const claimed = await dbWrite.$queryRaw<{ id: number }[]>`
    UPDATE "CollectionItem"
    SET "reviewedById" = ${SYSTEM_USER_ID}, "reviewedAt" = now(), "updatedAt" = now()
    WHERE "collectionId" = ${collectionId}
      AND id IN (${Prisma.join(outcomes.map((o) => o.collectionItemId))})
      AND status = 'REVIEW'
      AND "reviewedById" IS NULL
    RETURNING id
  `;
  if (!claimed.length) return;

  const claimedIds = new Set(claimed.map((row) => row.id));
  const applicable = outcomes.filter((o) => claimedIds.has(o.collectionItemId));

  const accepted = applicable.filter((o) => o.action === 'accept').map((o) => o.collectionItemId);
  const rejected = new Map<string, number[]>();
  for (const outcome of applicable) {
    if (outcome.action !== 'reject') continue;
    const message = outcome.message ?? '';
    rejected.set(message, [...(rejected.get(message) ?? []), outcome.collectionItemId]);
  }

  const writes: { ids: number[]; status: CollectionItemStatus; reason?: string }[] = [];
  if (accepted.length) writes.push({ ids: accepted, status: CollectionItemStatus.ACCEPTED });
  for (const [reason, ids] of rejected)
    writes.push({ ids, status: CollectionItemStatus.REJECTED, reason });

  // Isolated so one failing group cannot take the others down with it.
  for (const write of writes) {
    try {
      await updateCollectionItemsStatus({
        input: {
          collectionId,
          collectionItemIds: write.ids,
          status: write.status,
          rejectionReason: resolveAutomatedRejectionReason({ status: write.status }),
        },
        userId: SYSTEM_USER_ID,
        isSystem: true,
        rejectionDetail: write.reason,
      });
    } catch (error) {
      logToAxiom({
        type: 'job-error',
        name: 'collection-ai-review',
        collectionId,
        error: `Failed to apply ${write.status} to ${write.ids.length} items: ${
          (error as Error).message
        }`,
      }).catch(() => undefined);
    }
  }
}
