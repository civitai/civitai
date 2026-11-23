import * as z from 'zod';
import { RESOLUTION_NOTE_MAX_LENGTH } from '@civitai/shared/resolution-reasons';
import { modelId } from '~/server/schema/moderator/minor-flag';
import { RESTRICTED_NSFW_VERDICT_RULINGS } from '~/server/services/text-scan/actions/restricted-nsfw-verdict';

/** The body of `model/resolve-restricted-nsfw-verdict`. */
export const resolveRestrictedNsfwVerdictInput = z.object({
  modelId,
  ruling: z.enum(RESTRICTED_NSFW_VERDICT_RULINGS).describe('The button the moderator pressed.'),
  reason: z
    .string()
    .trim()
    .max(RESOLUTION_NOTE_MAX_LENGTH)
    .optional()
    .describe('Why, or where the lead was escalated. Required to dismiss a minor lead.'),
  revision: z
    .string()
    .max(128)
    .optional()
    .describe('The revision of the lead the moderator was shown; refused if it has changed.'),
});

/** The ruling the endpoint makes for a parsed body, as the moderator `userId`. */
export const restrictedNsfwRulingArgs = (
  input: z.infer<typeof resolveRestrictedNsfwVerdictInput>,
  userId: number
) => ({
  modelId: input.modelId,
  ruling: input.ruling,
  reason: input.reason,
  userId,
  revision: input.revision,
});
