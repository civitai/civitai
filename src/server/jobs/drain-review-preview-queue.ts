import { createJob } from './job';

/**
 * Starts queued review-preview builds while platform build slots are free (review-autodeploy
 * .service). Builds settling and teardowns drain the queue too; this run catches a slot freed any
 * other way (a stale build, an approve or reject of a building request) and a drain that failed.
 */
export const drainReviewPreviewQueueJob = createJob(
  'drain-review-preview-queue',
  '* * * * *',
  async () => {
    const { drainReviewPreviewQueue } = await import(
      '~/server/services/blocks/review-autodeploy.service'
    );
    return drainReviewPreviewQueue();
  }
);
