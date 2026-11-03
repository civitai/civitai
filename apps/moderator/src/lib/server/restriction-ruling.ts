import { z } from 'zod';
import { int4Id, parseForm } from './query';
import { checkedResolutionReason, resolutionReasonFields } from './resolution-reason';

const rulingSchema = z.object({
  userRestrictionId: int4Id,
  status: z.enum(['Upheld', 'Overturned']),
  ...resolutionReasonFields,
});

export type RestrictionRulingInput = z.infer<typeof rulingSchema>;

/**
 * Parses a ruling form's shape. The reason is checked separately by `rulingReason`, after the caller's
 * row checks: a missing or unwired restriction answers with its own refusal, not "pick a reason".
 */
export function parseRestrictionRuling(
  form: FormData
): { ok: true; input: RestrictionRulingInput } | { ok: false; error: string } {
  const input = parseForm(rulingSchema, form);
  if (typeof input === 'string') return { ok: false, error: input };
  return { ok: true, input };
}

export function rulingReason(
  input: RestrictionRulingInput
):
  | { ok: true; resolvedReason: string; internalNotes: string | undefined }
  | { ok: false; error: string } {
  const reason = checkedResolutionReason('restriction', input.status, input);
  if (typeof reason === 'string') return { ok: false, error: reason };
  return { ok: true, ...reason };
}
