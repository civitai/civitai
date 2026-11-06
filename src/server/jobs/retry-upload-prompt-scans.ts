import { dbRead } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { labelUploadPrompt } from '~/server/services/upload-prompt-scan.service';
import {
  queueUploadPromptRetry,
  takeDueUploadPromptRetries,
  type DueUploadPromptRetry,
} from '~/server/services/upload-prompt-retry.service';

/** Scans run at once. Each waits on the orchestrator for up to its own deadline. */
const CONCURRENCY = 5;
const MAX_PER_RUN = 500;
const LOCK_SECONDS = 10 * 60;
/** No new batch starts past this, so the batch in flight ends before the lock lapses. */
const RUN_BUDGET_MS = 7 * 60 * 1000;

type ImageRow = {
  id: number;
  userId: number;
  prompt: string | null;
  negativePrompt: string | null;
};

export type RetryUploadPromptScansDeps = {
  take: (limit: number) => Promise<DueUploadPromptRetry[]>;
  loadImages: (ids: number[]) => Promise<ImageRow[]>;
  label: typeof labelUploadPrompt;
  requeue: typeof queueUploadPromptRetry;
  now: () => number;
};

const defaultDeps: RetryUploadPromptScansDeps = {
  take: (limit) => takeDueUploadPromptRetries({ limit }),
  loadImages: (ids) => dbRead.$queryRaw<ImageRow[]>`
    SELECT id, "userId", meta->>'prompt' AS prompt, meta->>'negativePrompt' AS "negativePrompt"
    FROM "Image"
    WHERE id = ANY(${ids}::int[])
  `,
  label: labelUploadPrompt,
  requeue: queueUploadPromptRetry,
  now: Date.now,
};

/**
 * Scans again the upload prompts whose scan had no verdict, when each is due. Each scan only adds
 * a label for moderators to verify; a scan with no verdict again queues its next retry, until the
 * cap in `upload-prompt-retry.service.ts`. An image that is gone or has no prompt is dropped.
 */
export async function retryUploadPromptScans(deps: RetryUploadPromptScansDeps = defaultDeps) {
  const startedAt = deps.now();
  let taken = 0;
  let scanned = 0;
  let dropped = 0;
  while (taken < MAX_PER_RUN && deps.now() - startedAt < RUN_BUDGET_MS) {
    const due = await deps.take(Math.min(CONCURRENCY, MAX_PER_RUN - taken));
    if (!due.length) break;
    taken += due.length;
    let rows: ImageRow[];
    try {
      rows = await deps.loadImages(due.map((d) => d.imageId));
    } catch (error) {
      // The entries are already off the queue. Counting the failure as their attempt keeps them
      // bounded by the same cap; the run stops, as the next batch would fail the same way.
      await Promise.all(
        due.map(({ imageId, attempt }) => deps.requeue({ imageId, attempt: attempt + 1 }))
      );
      throw error;
    }
    const images = new Map(rows.map((row) => [row.id, row]));
    await Promise.all(
      due.map(async ({ imageId, attempt }) => {
        const image = images.get(imageId);
        const prompt = image?.prompt;
        if (!image || !prompt?.trim()) {
          dropped++;
          return;
        }
        scanned++;
        await deps
          .label({
            imageId,
            userId: image.userId,
            prompt,
            negativePrompt: image.negativePrompt ?? undefined,
            attempt,
          })
          .catch(() => null);
      })
    );
  }
  return { taken, scanned, dropped };
}

export const retryUploadPromptScansJob = createJob(
  'retry-upload-prompt-scans',
  '4,14,24,34,44,54 * * * *',
  () => retryUploadPromptScans(),
  { lockExpiration: LOCK_SECONDS }
);
