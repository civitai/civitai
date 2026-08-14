/**
 * Retool-callable mod endpoints for the minor-flag review queues.
 * ==============================================================
 *
 * Auth: Bearer <user API key> (mod role required).
 *
 * Why this exists: the moderator app ports the three READ queues of
 * `/moderator/minor-hash-matches`, but none of the writes can move with them.
 * `revert` runs `setModelMinor`, which owns the search-index sync, the cache
 * busting and the per-image `minor` propagation, and then restores five columns
 * from the flag snapshot; `resolveAppeal` additionally closes the `Appeal` row.
 * Re-deriving any of that in the spoke would be a second implementation of a
 * minor-safety decision — so the spoke reads, and the verdict is written here.
 *
 * POST /api/mod/retool/minor-flag
 * Body: { "action": "<action>", ...params }
 *
 * Actions:
 *   setMinor      - { modelId } Flag a hash MATCH as depicting a minor. The verdict
 *                   the Pending queue exists to reach; `setModelMinor` carries the
 *                   search index, the caches and the per-image propagation.
 *   confirm       - { modelId } Sign off an auto-flag. Promotes the snapshot to
 *                   source='manual', which also starts the model's hashes seeding
 *                   future matches.
 *   revert        - { modelId } Undo the flag and restore the pre-flag state.
 *   dismiss       - { modelId } Take a hash MATCH off the review queue without
 *                   flagging anything. Not a verdict on the model.
 *   resolveAppeal - { modelId, uphold } Rule on a pending minor-flag appeal.
 *                   Upholding refuses if the model is no longer flagged.
 */
import * as z from 'zod';
import {
  confirmMinorHashAutoFlag,
  dismissMinorHashMatch,
  resolveMinorFlagAppeal,
  revertMinorHashAutoFlag,
} from '~/server/services/minor-hash.service';
import { setModelMinor } from '~/server/services/model.service';
import { defineRetoolEndpoint, retoolAction } from '~/server/utils/retool-endpoint';

const modelInput = z.object({ modelId: z.coerce.number().int().positive() });

// Every one of these is a per-model verdict a moderator clicks, so the ceiling is
// there to bound a stuck client, not to pace real work.
const rateLimit = { max: 60, windowSeconds: 60 };

export default defineRetoolEndpoint('minor-flag', {
  setMinor: retoolAction({
    input: modelInput,
    rateLimit,
    async handler(input, ctx) {
      await setModelMinor({ id: input.modelId, minor: true, userId: ctx.actor.id });
      return { flagged: input.modelId };
    },
  }),

  confirm: retoolAction({
    input: modelInput,
    rateLimit,
    async handler(input, ctx) {
      await confirmMinorHashAutoFlag({ modelId: input.modelId, userId: ctx.actor.id });
      return { confirmed: input.modelId };
    },
  }),

  revert: retoolAction({
    input: modelInput,
    rateLimit,
    async handler(input, ctx) {
      const report = await revertMinorHashAutoFlag({ modelId: input.modelId, userId: ctx.actor.id });
      // `rolledBack` is what the caller must read, not the 200: a model whose snapshot
      // capture failed has nothing to restore, and reverts as candidates 0 / rolledBack 0.
      return { reverted: report.rolledBack, failed: report.failed, candidates: report.candidates };
    },
  }),

  dismiss: retoolAction({
    input: modelInput,
    rateLimit,
    async handler(input, ctx) {
      await dismissMinorHashMatch({ modelId: input.modelId, userId: ctx.actor.id });
      return { dismissed: input.modelId };
    },
  }),

  resolveAppeal: retoolAction({
    input: modelInput.extend({ uphold: z.coerce.boolean() }),
    rateLimit,
    async handler(input, ctx) {
      await resolveMinorFlagAppeal({
        modelId: input.modelId,
        uphold: input.uphold,
        userId: ctx.actor.id,
      });
      return { resolved: input.uphold ? 'upheld' : 'overturned', modelId: input.modelId };
    },
  }),
});
