/**
 * Temporary: gives recent articles a system category for the Story Writers board; delete once its
 * window is classified. Re-running a chunk before its callbacks land resubmits (and bills) those
 * calls, so page with `nextAfterId`.
 */
import * as z from 'zod';
import { runArticleCategoryBackfill } from '~/server/services/text-scan/article-category-backfill';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

const schema = z.object({
  afterId: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(200).default(100),
  concurrency: z.number().int().min(1).max(4).default(2),
  dryRun: z.boolean().default(true),
});

export default defineModeratorEndpoint('textScan.articleCategoryBackfill', {
  summary: 'Story Writers backfill: send the category call for recent unclassified articles.',
  returns: '{ dryRun, selected, nextAfterId, byStatus, results }',
  notes: [
    'dryRun defaults to true and only lists the selection.',
    'Each submitted article is one billed category call; the category is written by its callback.',
  ],
  rateLimit: { max: 10, windowSeconds: 60 },
  input: schema,
  handler: (input) => runArticleCategoryBackfill(input),
});
