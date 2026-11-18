import type { WorkflowStepTemplate } from '@civitai/orchestration-client';
import { submitWorkflow } from '@civitai/orchestration-client';
import type { StudioDatasetRatingInput } from '~/server/schema/training-studio-dataset-rating.schema';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { isCivitaiMediaUrl } from '~/server/services/orchestrator/trusted-blob-url';
import { toOrchestratorError } from '~/server/services/training.service';
import { throwBadRequestError, throwRateLimitError } from '~/server/utils/errorHandling';

/**
 * The Training Studio's v2 dataset rating, run on the system token like its auto-label: it is free
 * to the user. A step submitted with the user's own token charges them for every image. The Studio
 * parses each step's output (apps/training-studio/src/lib/dataset-rating.ts `parseRatingV2`).
 */

export const STUDIO_DATASET_RATING_RATER = 'radio-alpha';
/** Images one user may have rated per UTC day; the Studio's own per-user allowance is the same. */
export const STUDIO_DATASET_RATING_DAILY_IMAGES = 3000;
/** Under the Studio's 30s rating deadline; a step still running then answers no output. */
const WAIT_SECONDS = 20;
const IMAGE_PATH = /\.(png|jpe?g|webp|gif|bmp)$/i;

type StudioDatasetRatingMetadata = { kind: 'studio-dataset-rating'; userId: number };

/** An image the orchestrator hosts: the only media this endpoint sends to the rater. */
export function isRateableMediaUrl(raw: string): boolean {
  return isCivitaiMediaUrl(raw) && IMAGE_PATH.test(new URL(raw).pathname);
}

export async function rateStudioDatasetImages({
  userId,
  items,
}: StudioDatasetRatingInput & { userId: number }): Promise<{
  results: { key: string; output: unknown }[];
}> {
  if (!items.every((i) => isRateableMediaUrl(i.mediaUrl)))
    throw throwBadRequestError('Dataset rating only accepts images uploaded to Civitai.');
  const release = await reserveDailyImages(userId, items.length);

  const metadata: StudioDatasetRatingMetadata = { kind: 'studio-dataset-rating', userId };
  const steps = items.map(
    (item, i) =>
      ({
        $type: 'imageScanning',
        name: `${i}`,
        metadata: { ...metadata, key: item.key },
        // `rater-model` is not in the client's ImageScanningInput type yet.
        input: { image: item.mediaUrl, 'rater-model': STUDIO_DATASET_RATING_RATER },
      } as unknown as WorkflowStepTemplate)
  );
  const { data, error } = await submitWorkflow({
    client: internalOrchestratorClient,
    query: { wait: WAIT_SECONDS },
    body: {
      tags: ['civitai', 'training-studio', 'dataset-rating'],
      metadata,
      steps,
      currencies: [],
    },
  }).catch(async (e: unknown) => {
    await release();
    throw e;
  });
  if (!data) {
    await release();
    toOrchestratorError(error);
  }
  const byName = new Map((data.steps ?? []).map((s) => [s.name, s]));
  return {
    results: items.map((item, i) => {
      const step = byName.get(`${i}`) as { status?: string; output?: unknown } | undefined;
      return { key: item.key, output: step?.status === 'succeeded' ? step.output ?? null : null };
    }),
  };
}

/** Counts `count` images against the user's UTC-day quota, refusing past it. Fails closed: if the
 *  counter can't be read, nothing is submitted. Returns a release for a submit that didn't happen. */
async function reserveDailyImages(userId: number, count: number) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${REDIS_KEYS.TRAINING_STUDIO.DATASET_RATING_DAILY}:${userId}:${day}` as const;
  const total = await redis.incrBy(key, count);
  if (total === count) await redis.expire(key, 2 * 24 * 60 * 60);
  const release = async () => {
    await redis.decrBy(key, count).catch(() => undefined);
  };
  if (total > STUDIO_DATASET_RATING_DAILY_IMAGES) {
    await release();
    throw throwRateLimitError("You've reached today's dataset rating limit.");
  }
  return release;
}
