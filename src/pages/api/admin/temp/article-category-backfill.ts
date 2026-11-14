/**
 * Story Writers board: give recent articles a system category (`Article.systemCategoryId`), which
 * otherwise only new scans and edits get. Deleted once the board's window is all classified.
 *
 * POST /api/admin/temp/article-category-backfill   (moderator session or `Authorization: Bearer <moderator API key>`)
 *   { "afterId"?: 0, "limit"?: 100, "concurrency"?: 2, "dryRun"?: true }
 *     Selects up to `limit` articles after `afterId`, by id, that the board could score and that have
 *     no system category yet. A dry run returns them and submits nothing. Otherwise each gets one
 *     category call (billed); its callback writes the category later. Page with `nextAfterId`; a
 *     chunk re-run before its callbacks land sends those calls again.
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
