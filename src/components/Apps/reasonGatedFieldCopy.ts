/**
 * App Store Listings — the COPY a reason-gated free-text field renders: its live
 * counter and its inline error, as pure (React-free) functions.
 *
 * Extracted from {@link ReasonGatedField} for the reason the rest of this feature's
 * view models were extracted: the browser-mode suites are REPORT-ONLY in this repo's
 * CI, so a string built inline in JSX is pinned by nothing that can block a merge.
 * The CEILING half is the case that motivated it — deleting the `(max N)` suffix left
 * every blocking suite green while the one moderator field with a server-enforced
 * maximum silently stopped naming it, which is exactly the state that lets a
 * moderator fill a field the server will reject.
 *
 * 🔴 BEHAVIOUR-PRESERVING BY CONSTRUCTION, and that matters because five pre-existing
 * call sites pass no ceiling at all. `maxLength == null` must render the byte-identical
 * description and error those callers have always rendered; the no-ceiling cases are
 * pinned first in `__tests__/reasonGatedFieldCopy.test.ts` for that reason.
 */

/** The shared inputs both strings are derived from. `length` is the TRIMMED length. */
export type ReasonGatedFieldCopyInput = {
  /** The TRIMMED length of the current value — what both strings count. */
  length: number;
  minLength: number;
  /** The optional ceiling. `null`/`undefined` = no ceiling (every legacy caller). */
  maxLength?: number | null;
  /** When false this is an OPTIONAL note: no counter, no floor, no floor error. */
  required: boolean;
};

/**
 * The live counter under the field.
 *
 * `undefined` for an optional note (no floor to count toward). The ceiling is appended
 * ONLY when one was given, so a caller that passes none keeps its exact copy.
 */
export function reasonGatedFieldDescription(input: ReasonGatedFieldCopyInput): string | undefined {
  if (!input.required) return undefined;
  const counter = `${input.length}/${input.minLength} characters minimum`;
  return input.maxLength != null ? `${counter} (max ${input.maxLength})` : counter;
}

/**
 * The inline error, or `undefined` when the field is fine.
 *
 * 🔴 TOO-LONG OUTRANKS TOO-SHORT and is NOT gated on `required`: a ceiling is a server
 * rejection either way, so an optional note that overshoots still says so. Too-short
 * needs the `length > 0` grace period — an untouched required field shows the neutral
 * counter, not a red error — while too-long needs none, since it can only be reached
 * by typing.
 */
export function reasonGatedFieldError(input: ReasonGatedFieldCopyInput): string | undefined {
  if (input.maxLength != null && input.length > input.maxLength) {
    return `Keep it to ${input.maxLength} characters or fewer (currently ${input.length}).`;
  }
  if (input.required && input.length < input.minLength && input.length > 0) {
    return `Enter at least ${input.minLength} characters.`;
  }
  return undefined;
}
