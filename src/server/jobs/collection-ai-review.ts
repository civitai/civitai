import { Prisma } from '@prisma/client';
import pLimit from 'p-limit';
import { CollectionItemStatus } from '~/shared/utils/prisma/enums';
import { dbWrite } from '~/server/db/client';
import { Tracker } from '~/server/clickhouse/tracker';
import { logToAxiom } from '~/server/logging/client';
import type { CollectionAiReviewSchema } from '~/server/schema/collection.schema';
import { updateCollectionItemsStatus } from '~/server/services/collection.service';
import {
  decideFromObservations,
  isAiReviewAvailable,
  isNsfwLevelAllowed,
  isUnratedNsfwLevel,
  resolveRejectionMessage,
  reviewImage,
} from '~/server/services/ai/collection-review.service';
import type { AiReviewDecision } from '~/server/services/ai/collection-review.service';
import { isDefined } from '~/utils/type-guards';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { createJob } from './job';

const SYSTEM_USER_ID = -1;
// One run must finish well inside the cron period: the lock TTL is not renewed, so an overrun lets
// the next tick start on the same rows.
const BATCH_SIZE = 50;
const CHUNK_SIZE = 10;
const CONCURRENCY = 5;

type PendingItem = {
  collectionItemId: number;
  imageId: number;
  url: string;
  type: string;
  nsfwLevel: number;
  prompt: string | null;
};

export const collectionAiReview = createJob(
  'collection-ai-review',
  '*/15 * * * *',
  async () => {
    if (!isAiReviewAvailable()) return;

    const collections = await dbWrite.$queryRaw<{ id: number; metadata: unknown }[]>`
      SELECT id, metadata
      FROM "Collection"
      WHERE metadata->'aiReview'->>'enabled' = 'true'
    `;

    for (const collection of collections) {
      const config = (collection.metadata as { aiReview?: CollectionAiReviewSchema })?.aiReview;
      if (!config?.enabled) continue;

      await withDistributedLock(
        // A run that overlaps itself would double-bill and double-notify. maxRetries 0 means a
        // still-running batch is skipped rather than queued behind the lock.
        { key: `collection-ai-review:${collection.id}`, ttl: 900, maxRetries: 0 },
        () => reviewCollection(collection.id, config)
      );
    }
  },
  { lockExpiration: 900 }
);

async function reviewCollection(collectionId: number, config: CollectionAiReviewSchema) {
  // reviewedById marks an item as already seen, so nothing is reclassified — or re-billed — on a
  // later run.
  const pending = await dbWrite.$queryRaw<PendingItem[]>`
    SELECT ci.id "collectionItemId", i.id "imageId", i.url, i.type::text, i."nsfwLevel",
           i.meta->>'prompt' prompt
    FROM "CollectionItem" ci
    JOIN "Image" i ON i.id = ci."imageId"
    WHERE ci."collectionId" = ${collectionId}
      AND ci.status = 'REVIEW'
      AND ci."reviewedById" IS NULL
    ORDER BY ci.id
    LIMIT ${BATCH_SIZE}
  `;

  // Ingestion has not rated these yet, so there is no level to check them against. Skipped rather
  // than stamped, so they are picked up once they have one.
  const reviewable = pending.filter((item) => !isUnratedNsfwLevel(item.nsfwLevel));
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
  action: 'accept' | 'reject' | 'stamp';
  message?: string;
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
  let usage = { promptTokens: 0, completionTokens: 0 };

  if (!isNsfwLevelAllowed(item.nsfwLevel, config.allowedNsfwLevels)) {
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
      decision = decideFromObservations(result.observations);
      reason = (result.observations as { reason?: string } | null)?.reason?.slice(0, 500) ?? '';
    } catch (error) {
      logToAxiom({
        type: 'job-error',
        name: 'collection-ai-review',
        collectionId,
        imageId: item.imageId,
        error: (error as Error).message,
      }).catch(() => undefined);
      // Stamped so a permanently broken image (the CDN refuses some of them) is not retried on
      // every run for the life of the collection.
      return { collectionItemId: item.collectionItemId, action: 'stamp' };
    }
  }

  const applied = !config.dryRun;
  let action: Outcome['action'] = 'stamp';
  let message: string | undefined;

  if (applied) {
    if (decision.decision === 'approve') action = 'accept';
    else if (decision.decision === 'reject' || config.escalationAction === 'reject') {
      action = 'reject';
      message = resolveRejectionMessage(decision.violations, config.reasonCopy);
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

  return { collectionItemId: item.collectionItemId, action, message };
}

/**
 * Every item is stamped before any status is written. A status write can throw — a collection with
 * judgesCanScoreEntries rejects a batch whose items lack scores — and an unstamped item is selected
 * again on the next run, so stamping last would mean re-classifying and re-billing forever. A
 * stamped item whose status write failed stays visible in the moderator queue.
 */
async function applyOutcomes({
  collectionId,
  outcomes,
}: {
  collectionId: number;
  outcomes: Outcome[];
}) {
  if (!outcomes.length) return;

  await dbWrite.$executeRaw`
    UPDATE "CollectionItem"
    SET "reviewedById" = ${SYSTEM_USER_ID}, "reviewedAt" = now(), "updatedAt" = now()
    WHERE "collectionId" = ${collectionId}
      AND id IN (${Prisma.join(outcomes.map((o) => o.collectionItemId))})
  `;

  const accepted = outcomes.filter((o) => o.action === 'accept').map((o) => o.collectionItemId);
  const rejected = new Map<string, number[]>();
  for (const outcome of outcomes) {
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
        input: { collectionId, collectionItemIds: write.ids, status: write.status },
        userId: SYSTEM_USER_ID,
        isSystem: true,
        reason: write.reason,
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
