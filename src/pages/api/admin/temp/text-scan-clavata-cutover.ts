/**
 * Text-scan rollout: switch Clavata text moderation off for one entity once its text-scan flag is
 * fully `active`. Deleted with the Clavata text job.
 *
 * POST /api/admin/temp/text-scan-clavata-cutover   (moderator session or `Authorization: Bearer <moderator API key>`)
 *   { "action": "status" }
 *   { "action": "disable", "entityType": "Post", "allowUnmoderated"?: false }
 *       409 unless every probed recent id evaluates `active`. Sets the Clavata ENTITIES override
 *       to false and drains that entity's ModerationRequest JobQueue rows. Idempotent: run it
 *       again after the trigger drop to clear rows enqueued in between. `drain.complete: false`
 *       means the batch cap was hit; run it again.
 *       `allowUnmoderated: true` skips the probe and is accepted for ChatMessage and Collection
 *       only. Use it only with a recorded sign-off: the entity is then scanned by nothing.
 *   { "action": "enable", "entityType": "Post" }
 *       Rollback. Removes the override; does NOT recreate the trigger.
 */
import * as z from 'zod';
import type { CutoverEntityType } from '~/server/services/text-scan/clavata-cutover';
import {
  disableClavataFor,
  enableClavataFor,
  getClavataCutoverStatus,
  isCutoverEntityType,
} from '~/server/services/text-scan/clavata-cutover';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';

const entityType = z
  .string()
  .refine(isCutoverEntityType, 'not a Clavata-scanned entity')
  .transform((value) => value as CutoverEntityType);

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({
    action: z.literal('disable'),
    entityType,
    allowUnmoderated: z.boolean().default(false),
  }),
  z.object({ action: z.literal('enable'), entityType }),
]);

export default defineModeratorEndpoint('textScan.clavataCutover', {
  summary: 'Text-scan rollout: switch Clavata text moderation off (or back on) for one entity.',
  returns: 'status rows, or the disable/enable result; 409 when a disable is refused',
  notes: [
    'disable is refused unless every probed recent id of the entity evaluates `active`.',
    'allowUnmoderated is accepted for ChatMessage and Collection only, and only with a recorded sign-off.',
    'enable does not recreate the dropped trigger.',
  ],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: schema,
  async handler(input) {
    if (input.action === 'status') return { targets: await getClavataCutoverStatus() };
    if (input.action === 'enable') return enableClavataFor(input.entityType);
    return disableClavataFor(input.entityType, { allowUnmoderated: input.allowUnmoderated });
  },
});
