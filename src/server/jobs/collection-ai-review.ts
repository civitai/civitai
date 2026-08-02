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
  isNsfwLevelAllowed,
  resolveRejectionMessage,
  reviewImage,
} from '~/server/services/ai/collection-review.service';
import type { AiReviewViolation } from '~/server/services/ai/collection-review.service';
import { withDistributedLock } from '~/server/utils/distributed-lock';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { createJob } from './job';

const SYSTEM_USER_ID = -1;
const BATCH_SIZE = 200;
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
  // reviewedById marks an item as already seen, so items left for a human are not reclassified
  // (and not re-billed) on the next run.
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
  if (!pending.length) return;

  const tracker = new Tracker();
  const accepted: number[] = [];
  const rejected = new Map<string, number[]>();
  const escalated: number[] = [];
  const limit = pLimit(CONCURRENCY);

  const classify = async (item: PendingItem) => {
    let decision: 'approve' | 'reject' | 'escalate';
    let violations: AiReviewViolation[] = [];
    let escalations: string[] = [];
    let reason = '';
    let usage = { promptTokens: 0, completionTokens: 0 };

    if (!isNsfwLevelAllowed(item.nsfwLevel, config.allowedNsfwLevels)) {
      decision = 'reject';
      violations = ['sexual/adult content'];
      reason = `Rated above the levels this collection allows (nsfwLevel ${item.nsfwLevel}).`;
    } else {
      try {
        const result = await reviewImage({
          imageUrl: getEdgeUrl(item.url, {
            width: 512,
            anim: item.type === 'video' ? false : undefined,
            transcode: item.type === 'video' ? true : undefined,
            name: 'image',
          }),
          prompt: item.prompt,
          model: config.model,
          systemPrompt: config.prompt,
        });
        if (!result) return;

        ({ usage } = result);
        ({ decision, violations, escalations } = decideFromObservations(result.observations));
        reason = result.observations.reason ?? '';
      } catch (error) {
        logToAxiom({
          type: 'job-error',
          name: 'collection-ai-review',
          collectionId,
          imageId: item.imageId,
          error: (error as Error).message,
        }).catch(() => undefined);
        return;
      }
    }

    const applied = !config.dryRun;
    if (applied) {
      if (decision === 'approve') accepted.push(item.collectionItemId);
      else if (decision === 'reject' || config.escalationAction === 'reject') {
        const message = resolveRejectionMessage(violations, config.reasonCopy);
        const bucket = rejected.get(message) ?? [];
        bucket.push(item.collectionItemId);
        rejected.set(message, bucket);
      } else escalated.push(item.collectionItemId);
    }

    tracker.collectionAiReview({
      collectionId,
      collectionItemId: item.collectionItemId,
      entityId: item.imageId,
      userId: SYSTEM_USER_ID,
      model: config.model,
      decision,
      violations,
      escalations,
      reason,
      applied,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    });
  };

  await Promise.all(
    pending
      // A zero level means ingestion has not rated the image yet; leave it for a later run.
      .filter((item) => item.nsfwLevel !== 0)
      .map((item) => limit(() => classify(item)))
  );

  if (accepted.length) {
    await updateCollectionItemsStatus({
      input: { collectionId, collectionItemIds: accepted, status: CollectionItemStatus.ACCEPTED },
      userId: SYSTEM_USER_ID,
      isSystem: true,
    });
  }

  for (const [message, ids] of rejected) {
    await updateCollectionItemsStatus({
      input: { collectionId, collectionItemIds: ids, status: CollectionItemStatus.REJECTED },
      userId: SYSTEM_USER_ID,
      isSystem: true,
      reason: message,
    });
  }

  if (escalated.length) {
    await dbWrite.$executeRaw`
      UPDATE "CollectionItem"
      SET "reviewedById" = ${SYSTEM_USER_ID}, "reviewedAt" = now(), "updatedAt" = now()
      WHERE "collectionId" = ${collectionId} AND id IN (${Prisma.join(escalated)})
    `;
  }
}
