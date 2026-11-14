import * as z from 'zod';
import { REVIEW_BATCH_MAX_IDS } from '@civitai/shared/review-batch';
import { mintReviewBatch } from '~/server/services/review-batch/review-batch.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';

export default defineModeratorEndpoint('reviewBatches.mint', {
  summary:
    'Mint a review sheet batch: a short-lived link that shows a moderator a set of site images on the Hub phone sheet, routed to the general or the held tier by the server.',
  returns: "{ batchId, tier: 'general' | 'held', link }",
  notes: [
    'Requires a personal API key of a moderator holding the held-media grant (`csamReports`); the viewer must hold it too.',
    'The tier is decided here, never by the caller: any image with a CSAM or minor signal, any image whose signals cannot be read, a batch with no source card, or source text naming a suspect term sends the batch to the held tier.',
    'A repeat with the same `idempotencyKey` from the same key revokes the batch it minted before and mints a new one; a repeat while one is in flight answers 409.',
    'The source text is read and never stored, not even in this audit row.',
    'Brake: the Flipt flag `review-batches-mint`; off answers 503.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 * 60 },
  auditExclude: ['sourceText', 'suspect'],
  input: z.object({
    ids: z.array(z.number().int().positive().max(2_147_483_647)).min(1).max(REVIEW_BATCH_MAX_IDS),
    viewer: z.number().int().positive().max(2_147_483_647),
    suspect: moderatorBoolean,
    source: z.string().trim().max(200),
    sourceText: z.array(z.string().max(20_000)).max(20),
    seat: z
      .string()
      .regex(/^ag_[0-9a-f]{16}$/)
      .optional(),
    idempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9_-]{22}$/)
      .optional(),
  }),
  async handler(input, ctx) {
    const minted = await mintReviewBatch(input, ctx);
    return { ...minted, affected: { tier: minted.tier, count: new Set(input.ids).size } };
  },
});
