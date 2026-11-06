import * as z from 'zod';
import {
  RESOLUTION_NOTE_MAX_LENGTH,
  resolutionReasonError,
} from '@civitai/shared/resolution-reasons';
import { ruleModelTextScanFlag } from '~/server/services/text-scan/actions/flag-ruling';
import { TEXT_SCAN_FLAG_LABELS } from '~/server/services/text-scan/flag-snapshot';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { defineModeratorEndpoint, moderatorBoolean } from '~/server/utils/moderator-endpoint';
import { minorFlagRateLimit, modelId } from '~/server/schema/moderator/minor-flag';

export default defineModeratorEndpoint('minorFlag.rule', {
  summary:
    'Rule on a standing text-scan minor or real-person flag outside an appeal: keep it or lift it.',
  returns: '{ ruled: "kept" | "lifted" | "keptMinor", label, modelId }',
  notes: [
    '`keep: false` lifts the flag and closes an open owner appeal on it; `keep: true` records that the flag stands.',
    "Refuses when the model has no such flag, or when `textHash` is not the flag's current text hash (the text changed; reload).",
    'A keep is refused while the owner has an open appeal: rule it through `resolveAppeal`.',
    "`resolvedReason` is optional; when sent it must belong to the verdict (`flagReview`: Kept or Lifted) and to `label`, or the request is refused. It is stamped on the label's ruling. The reason is optional at the API and required by the moderator UI.",
  ],
  rateLimit: minorFlagRateLimit,
  input: z.object({
    modelId,
    label: z.enum(TEXT_SCAN_FLAG_LABELS).describe('The flag to rule on.'),
    keep: moderatorBoolean.describe('True keeps the flag, false lifts it.'),
    textHash: z
      .string()
      .min(1)
      .max(200)
      .describe('The flagged text hash the ruling was made on; changed text is refused.'),
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
        'flagReview',
        input.keep ? 'Kept' : 'Lifted',
        input.resolvedReason,
        input.internalNotes,
        [input.label]
      );
      if (invalid) throw throwBadRequestError(invalid);
    }
    const ruled = await ruleModelTextScanFlag({
      modelId: input.modelId,
      label: input.label,
      keep: input.keep,
      textHash: input.textHash,
      userId: ctx.actor.id,
      reason: input.resolvedReason || undefined,
      note: input.internalNotes || undefined,
    });
    return { ...ruled, affected: { modelIds: [input.modelId] } };
  },
});
