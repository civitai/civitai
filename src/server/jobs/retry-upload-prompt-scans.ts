import { NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
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
  /** True once run-jobs has cancelled the run (the caller went away): no new batch starts. */
  isCanceled?: () => boolean;
};

/** The images still due a prompt scan, of `ids`, with their prompts. */
export const loadRetryImages = (ids: number[]) =>
  dbRead.$queryRaw<ImageRow[]>`
    SELECT id, "userId", meta->>'prompt' AS prompt, meta->>'negativePrompt' AS "negativePrompt"
    FROM "Image"
    WHERE id = ANY(${ids}::int[])
      -- Ingestion scans only R and above; an image rated down or blocked since has no scan due.
      AND ("nsfwLevel" & ${NsfwLevel.R | NsfwLevel.X | NsfwLevel.XXX}) <> 0
      AND ingestion <> 'Blocked'::"ImageIngestionStatus"
  `;

const defaultDeps: RetryUploadPromptScansDeps = {
  take: (limit) => takeDueUploadPromptRetries({ limit }),
  loadImages: loadRetryImages,
  label: labelUploadPrompt,
  requeue: queueUploadPromptRetry,
  now: Date.now,
};

/**
 * Scans again the upload prompts whose scan had no verdict, when each is due. Each scan only adds
 * a label for moderators to verify; a scan with no verdict again queues its next retry, until the
 * cap in `upload-prompt-retry.service.ts`. An image that is gone, has no prompt, is blocked or is
 * now rated below R is dropped.
 */
export async function retryUploadPromptScans(deps: RetryUploadPromptScansDeps = defaultDeps) {
  const startedAt = deps.now();
  let taken = 0;
  let scanned = 0;
  let dropped = 0;
  while (taken < MAX_PER_RUN && deps.now() - startedAt < RUN_BUDGET_MS && !deps.isCanceled?.()) {
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
          .catch((error) =>
            logToAxiom({
              name: 'upload-prompt-scan',
              type: 'error',
              message: `retry failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
              imageId,
              attempt,
            }).catch(() => null)
          );
      })
    );
  }
  return { taken, scanned, dropped };
}

export const retryUploadPromptScansJob = createJob(
  'retry-upload-prompt-scans',
  '4,14,24,34,44,54 * * * *',
  (ctx) => retryUploadPromptScans({ ...defaultDeps, isCanceled: () => ctx.status === 'canceled' }),
  // Keeps the lock if the caller disconnects, so a scheduler retry cannot start a second run
  // beside one still finishing its batch.
  { lockExpiration: LOCK_SECONDS, keepLockOnDisconnect: true }
);
