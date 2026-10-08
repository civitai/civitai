import { z } from 'zod';
import {
  RESOLUTION_NOTE_MAX_LENGTH,
  resolutionReasonError,
  type ResolutionSubject,
  type ResolutionVerdict,
} from '@civitai/shared/resolution-reasons';

/** Spread into a ruling action's form schema; `checkedResolutionReason` does the verdict check. */
export const resolutionReasonFields = {
  resolvedReason: z.string().trim().optional(),
  internalNotes: z.string().trim().max(RESOLUTION_NOTE_MAX_LENGTH).optional(),
};

/** The reason and note to record for this verdict, or the message to show instead. */
export function checkedResolutionReason<S extends ResolutionSubject>(
  subject: S,
  verdict: ResolutionVerdict<S>,
  input: { resolvedReason?: string; internalNotes?: string }
): { resolvedReason: string; internalNotes: string | undefined } | string {
  const error = resolutionReasonError(subject, verdict, input.resolvedReason, input.internalNotes);
  if (error) return error;
  return { resolvedReason: input.resolvedReason!, internalNotes: input.internalNotes || undefined };
}
