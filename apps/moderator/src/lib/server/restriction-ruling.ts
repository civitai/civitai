import { z } from 'zod';
import { int4Id, parseForm } from './query';
import { checkedResolutionReason, resolutionReasonFields } from './resolution-reason';

const rulingSchema = z.object({
  userRestrictionId: int4Id,
  status: z.enum(['Upheld', 'Overturned']),
  ...resolutionReasonFields,
});

export type RestrictionRuling = {
  userRestrictionId: number;
  status: 'Upheld' | 'Overturned';
  resolvedReason: string;
  internalNotes: string | undefined;
};

/** Parses and validates a ruling form. Checks that need the row (`unwiredRulingReason`, owner, status) stay with the caller. */
export function parseRestrictionRuling(
  form: FormData
): ({ ok: true } & RestrictionRuling) | { ok: false; error: string } {
  const input = parseForm(rulingSchema, form);
  if (typeof input === 'string') return { ok: false, error: input };
  const reason = checkedResolutionReason('restriction', input.status, input);
  if (typeof reason === 'string') return { ok: false, error: reason };
  return {
    ok: true,
    userRestrictionId: input.userRestrictionId,
    status: input.status,
    ...reason,
  };
}
