import * as z from 'zod';
import { RESOLUTION_NOTE_MAX_LENGTH } from '@civitai/shared/resolution-reasons';
import {
  RESTRICTED_NSFW_VERDICT_RULINGS,
  resolveRestrictedNsfwVerdict,
} from '~/server/services/text-scan/actions/restricted-nsfw-verdict';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { minorFlagRateLimit, modelId } from '~/server/schema/moderator/minor-flag';

export default defineModeratorEndpoint('model.resolveRestrictedNsfwVerdict', {
  summary:
    'Rule on a model the text scan rated NSFW while its owner had marked it minor, a real person or SFW-only.',
  returns: '{ modelId, ruling, restriction, nsfw, sfwOnly }',
  notes: [
    "`keep` leaves the owner's rating; on a model an earlier scan had locked NSFW it also turns nsfw off and lifts that system lock.",
    '`dismiss` closes the lead and changes nothing else. On a minor lead it needs a `reason`.',
    '`rateNsfw` unsets SFW-only, sets nsfw and locks it. Refused on a model marked minor or a real person.',
    'Refuses when the model has no pending lead. Every ruling logs a ModActivity row and records the values it replaced on the model.',
  ],
  rateLimit: minorFlagRateLimit,
  input: z.object({
    modelId,
    ruling: z.enum(RESTRICTED_NSFW_VERDICT_RULINGS).describe('The button the moderator pressed.'),
    reason: z
      .string()
      .trim()
      .max(RESOLUTION_NOTE_MAX_LENGTH)
      .optional()
      .describe('Why, or where the lead was escalated. Required to dismiss a minor lead.'),
  }),
  async handler(input, ctx) {
    const result = await resolveRestrictedNsfwVerdict({
      modelId: input.modelId,
      ruling: input.ruling,
      reason: input.reason,
      userId: ctx.actor.id,
    });
    return { ...result, affected: { modelIds: [input.modelId] } };
  },
});
