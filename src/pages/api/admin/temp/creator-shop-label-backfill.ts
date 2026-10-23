/** Temporary: delete once a production run's counts match the history. */
import * as z from 'zod';
import { runShopLabelBackfill } from '~/server/services/creator-shop-label-backfill.service';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';

const schema = z.object({
  dryRun: moderatorBoolean.default(true),
  afterId: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export default defineModeratorEndpoint('labelStore.creatorShopBackfill', {
  summary: 'Record past Creator Shop review verdicts in the label store.',
  returns:
    '{ dryRun, listings, fromHistory: { total, byAnswer }, inferred: { total, byAnswer }, alreadyRecorded, recorded, notRecorded, nextAfterId }',
  notes: [
    'dryRun defaults to true and counts every listing, recording nothing.',
    'A real run records `limit` listings after `afterId` and returns `nextAfterId` while more remain.',
    'Idempotent: each verdict has one source ref, shared with the live path.',
    'Inferred labels (listings reviewed before the history log) are counted apart and carry their own ref prefix.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: schema,
  async handler(input) {
    const result = await runShopLabelBackfill(input);
    return { ...result, affected: { recorded: result.recorded } };
  },
});
