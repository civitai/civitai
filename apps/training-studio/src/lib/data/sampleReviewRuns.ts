import type { Workflow } from '@civitai/orchestration-client';

/**
 * Raw workflows for the dev-login preview of runs stopped at the review gate. Raw rather than
 * pre-derived rows so the preview goes through the same `workflowToRow` / `workflowToDetail`
 * mapping a real held run does. Times are relative to `now`, so the long-held run is always past
 * the raise threshold and the fresh one never is.
 */
export function sampleReviewWorkflows(now = Date.now()): Workflow[] {
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const run = (
    id: string,
    name: string,
    status: string,
    moderationStatus: string,
    createdAt: string
  ) =>
    ({
      id,
      status,
      createdAt,
      tags: ['civitai', 'training'],
      metadata: { name, media: 'image', loraType: 'style', cardType: 'sdxl' },
      steps: [
        {
          $type: 'training',
          status,
          input: {
            engine: 'ai-toolkit',
            ecosystem: 'sdxl',
            epochs: 10,
            trainingData: { type: 'blobs', items: [] },
          },
          output: { moderationStatus, epochs: [] },
        },
      ],
    } as unknown as Workflow);

  return [
    run('preview-held', 'held_just_now', 'processing', 'underReview', hoursAgo(1)),
    run('preview-held-long', 'held_a_while', 'processing', 'underReview', hoursAgo(30)),
    run('preview-not-approved', 'not_approved', 'failed', 'rejected', hoursAgo(20)),
    run('preview-unreviewed', 'not_reviewed', 'expired', 'rejected', hoursAgo(50)),
  ];
}
