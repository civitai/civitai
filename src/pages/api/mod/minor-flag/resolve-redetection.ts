import * as z from 'zod';
import { resolveTextScanRedetection } from '~/server/services/text-scan/actions/redetection';
import { TEXT_SCAN_FLAG_LABELS } from '~/server/services/text-scan/flag-snapshot';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';
import { minorFlagRateLimit, modelId } from '~/server/schema/moderator/minor-flag';

export default defineModeratorEndpoint('minorFlag.resolveRedetection', {
  summary: 'Rule on a label the text scan re-detected after a human had cleared it.',
  returns: '{ resolved: "kept" | "dismissed" | "closed" }',
  notes: [
    '`keep` applies the flag exactly as the scan would have, including the owner notice.',
    'Dismissing clears the re-detected text and tells nobody.',
    'Refuses when the re-detection changed or was already resolved.',
    'An appeal the owner has open is resolved through `resolveAppeal`, not here.',
  ],
  rateLimit: minorFlagRateLimit,
  input: z.object({
    modelId,
    label: z.enum(TEXT_SCAN_FLAG_LABELS).describe('The flag the scan re-detected.'),
    keep: moderatorBoolean.describe('True keeps the flag, false dismisses the re-detection.'),
  }),
  async handler(input, ctx) {
    const resolved = await resolveTextScanRedetection({
      modelId: input.modelId,
      label: input.label,
      keep: input.keep,
      userId: ctx.actor.id,
    });
    return { resolved, modelId: input.modelId, affected: { modelIds: [input.modelId] } };
  },
});
