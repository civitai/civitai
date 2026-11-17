import * as z from 'zod';
import {
  RESOLUTION_NOTE_MAX_LENGTH,
  resolutionReasonError,
} from '@civitai/shared/resolution-reasons';
import { resolveTextScanRedetection } from '~/server/services/text-scan/actions/redetection';
import { TEXT_SCAN_FLAG_LABELS } from '~/server/services/text-scan/flag-snapshot';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';
import { minorFlagRateLimit, modelId } from '~/server/schema/moderator/minor-flag';

export default defineModeratorEndpoint('minorFlag.resolveRedetection', {
  summary:
    'Rule on a detection the text scan held: a re-detection after a human clear, or a first detection while the label is in review mode.',
  returns: '{ resolved: "kept" | "dismissed" | "closed" }',
  notes: [
    '`keep` applies the flag exactly as the scan would have, including the owner notice.',
    'Dismissing clears the held text and tells nobody; the same text is never held again.',
    'Refuses when the re-detection changed or was already resolved, or when `textHash` is not the pending one.',
    'Refuses while the owner has an open appeal: resolve it through `resolveAppeal` first.',
    "`resolvedReason` is optional; when sent it must belong to the verdict (`heldDetection`: Kept or Dismissed) and to `label`, or the request is refused. It is stamped on the label's ruling; a `closed` outcome stamps nothing.",
  ],
  rateLimit: minorFlagRateLimit,
  input: z.object({
    modelId,
    label: z.enum(TEXT_SCAN_FLAG_LABELS).describe('The flag the scan re-detected.'),
    textHash: z
      .string()
      .min(1)
      .max(200)
      .describe('The re-detected text hash the ruling was made on; a newer detection is refused.'),
    keep: moderatorBoolean.describe('True keeps the flag, false dismisses the re-detection.'),
    resolvedReason: z
      .string()
      .trim()
      .optional()
      .describe('A reason slug from @civitai/shared/resolution-reasons for this verdict.'),
    internalNotes: z
      .string()
      .trim()
      .max(RESOLUTION_NOTE_MAX_LENGTH)
      .optional()
      .describe('Moderator-only note. Never shown to the user.'),
  }),
  async handler(input, ctx) {
    if (input.resolvedReason) {
      const invalid = resolutionReasonError(
        'heldDetection',
        input.keep ? 'Kept' : 'Dismissed',
        input.resolvedReason,
        input.internalNotes,
        [input.label]
      );
      if (invalid) throw throwBadRequestError(invalid);
    }
    const resolved = await resolveTextScanRedetection({
      modelId: input.modelId,
      label: input.label,
      keep: input.keep,
      textHash: input.textHash,
      userId: ctx.actor.id,
      reason: input.resolvedReason || undefined,
      note: input.internalNotes || undefined,
    });
    return { resolved, modelId: input.modelId, affected: { modelIds: [input.modelId] } };
  },
});
