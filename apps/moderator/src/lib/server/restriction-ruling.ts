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

/**
 * A restriction ruling form, with the reason and note checked for the verdict. The caller still reads the
 * row and refuses what it cannot be ruled on (`unwiredRulingReason`, owner, status): those need the row.
 */
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
