/**
 * The TOS violation a storyline text report names when it is about the sexualization of a minor.
 * Equal to the entry in the main app's `TOS_VIOLATIONS`; `src/server/__tests__/report-post-text.test.ts`
 * holds the two together.
 */
export const MINOR_SEXUALIZATION_VIOLATION = 'Child abuse and exploitation';

/**
 * The TOS violations whose open report puts an image or post in a child-safety case, which holds a
 * delete of it (`childSafetyImageCase` in @civitai/db-queries/child-safety-case). Entries of
 * `TOS_VIOLATIONS`, held together by the same test.
 */
export const CHILD_SAFETY_VIOLATIONS = [
  MINOR_SEXUALIZATION_VIOLATION,
  'Photorealistic depiction of a minor',
] as const;

/**
 * Whether a report on a storyline text goes to the CSAM text-hold queue rather than an ordinary
 * refusal: a moderator's CSAM report, or a minor-sexualization violation from anyone.
 */
export function postTextReportOpensCsamHold({
  reason,
  details,
}: {
  reason: string;
  details: unknown;
}): boolean {
  if (reason === 'CSAM') return true;
  if (reason !== 'TOSViolation') return false;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return false;
  return (details as Record<string, unknown>).violation === MINOR_SEXUALIZATION_VIOLATION;
}
