import * as z from 'zod';
import { kyselyWrite } from '~/server/db/kyselyDb';
import { enqueueKnightsItems } from '~/server/services/knights/enqueue.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

const MAX_ITEMS = 1000;
const INT4_MAX = 2_147_483_647;

const item = z.object({
  imageId: z.number().int().positive().max(INT4_MAX),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  minRank: z.string().max(32).optional(),
  votesNeeded: z.number().int().positive().max(100).optional(),
  expiresAt: z.iso
    .datetime()
    .nullable()
    .transform((value) => (value === null ? null : new Date(value)))
    .optional(),
  prediction: z.json().optional(),
});

export default defineModeratorEndpoint('knights.enqueue', {
  summary: 'Put images in the Knights of New Order queue as one question.',
  privileged: 'knightsEnqueue',
  input: z.object({
    source: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    questionKey: z.string().min(1).max(100),
    items: z.array(item).min(1).max(MAX_ITEMS),
  }),
  returns: '{ results: [{ imageId, outcome, itemId? , reason? }] }',
  notes: [
    'Each item gets its own outcome: `enqueued` (with `itemId`), `duplicate` (the image already has an open item for this question) or `refused` (with a `reason`). A 200 does not mean every item was queued.',
    '`minRank` and `votesNeeded` default to the question’s; `expiresAt` defaults to one stage from now, `null` means never.',
    '`priority` 1 is served first.',
  ],
  async handler(input) {
    const results = await enqueueKnightsItems(kyselyWrite, input);
    return {
      results,
      affected: {
        questionKey: input.questionKey,
        source: input.source,
        enqueued: results.filter((r) => r.outcome === 'enqueued').length,
      },
    };
  },
});
