import { z } from 'zod';
import { BAN_REASONS } from '$lib/enforcement';
import { checkboxField } from './query';

/**
 * The ban form's fields, declared once for every action behind `BanConfirmForm`.
 *
 * Three call sites each re-declared these and had already drifted in two directions: one accepted an
 * empty `reasonCode` and two rejected it, and two enforced the "Other needs a note" rule while the
 * shared form advertised it on all three. A component that promises a rule its server does not apply is
 * worse than no rule.
 *
 * ⚠️ `reasonCode` must tolerate `''`. The picker renders a hidden input whenever it is given a `name`,
 * so an untouched dropdown posts an empty string — and the field is labelled optional, so leaving it
 * alone is the expected path, not an edge case.
 *
 * Deliberately does NOT carry the subject id: who is being banned is the one field each page must
 * resolve for itself, from something the page owns.
 */
export const banFieldsSchema = z.object({
  reasonCode: z
    .enum(BAN_REASONS)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  detailsInternal: z.string().trim().max(2000).optional(),
  detailsExternal: z.string().trim().max(2000).optional(),
  removeMedia: checkboxField,
  removeModels: checkboxField,
});

export type BanFields = z.infer<typeof banFieldsSchema>;

/** `Other` says nothing on its own, and the appeal reviewer reads it months later with no other
 *  context. Returns the refusal, or null when the ban may proceed. */
export function rejectUnexplainedOther(input: BanFields): string | null {
  return input.reasonCode === 'Other' && !input.detailsInternal
    ? 'A ban reasoned “Other” needs an internal note saying what it is for.'
    : null;
}
