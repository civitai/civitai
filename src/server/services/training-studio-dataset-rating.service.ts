import type { WorkflowStepTemplate } from '@civitai/orchestration-client';
import { submitWorkflow } from '@civitai/orchestration-client';
import type { StudioDatasetRatingInput } from '~/server/schema/training-studio-dataset-rating.schema';
import { internalOrchestratorClient } from '~/server/services/orchestrator/client';
import { isCivitaiMediaUrl } from '~/server/services/orchestrator/trusted-blob-url';
import { toOrchestratorError } from '~/server/services/training.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { usageLimits } from '~/shared/constants/usage-limits';

/** The Training Studio's v2 dataset rating, on the system token: a scan submitted with the user's own
 *  token is charged to them. */

export const STUDIO_DATASET_RATING_RATER = 'radio-alpha';
/** Per-minute and per-day images, counted per request (one image each) in the `training:` bucket. */
export const STUDIO_DATASET_RATING_RATE_LIMIT = {
  key: 'training:studioDatasetRating',
  rules: usageLimits('dataset-rating.submit', 'dataset-rating.daily'),
};
/** Under the Studio's 30s rating deadline; a step still running then answers no output. */
const WAIT_SECONDS = 20;
const IMAGE_PATH = /\.(png|jpe?g|webp|gif|bmp)$/i;

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

  const metadata = { kind: 'studio-dataset-rating', userId };
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
  });
  if (!data) toOrchestratorError(error);
  const byName = new Map((data.steps ?? []).map((s) => [s.name, s]));
  return {
    results: items.map((item, i) => {
      const step = byName.get(`${i}`) as { status?: string; output?: unknown } | undefined;
      return { key: item.key, output: step?.status === 'succeeded' ? step.output ?? null : null };
    }),
  };
}
