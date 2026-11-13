import { resolutionReasonsFor, type ResolutionReason } from '@civitai/shared/resolution-reasons';
import { decisionReasonProblem, suggestedReason } from '$lib/triage/decision-reasons';

export type RestrictionVerdict = 'Upheld' | 'Overturned';

/** In key order: digit `n + 1` picks index `n`. */
export const RESTRICTION_DECISIONS = [
  { verdict: 'Upheld', label: 'Uphold mute' },
  { verdict: 'Overturned', label: 'Overturn (remove mute)' },
] as const satisfies readonly { verdict: RestrictionVerdict; label: string }[];

export const restrictionDecisionReasons = (verdict: RestrictionVerdict): ResolutionReason[] => [
  ...resolutionReasonsFor('restriction', verdict),
];

/** The reason in the bar, or the verdict's only specific reason when none is picked. */
export const restrictionEffectiveReason = (verdict: RestrictionVerdict, picked: string): string =>
  picked || suggestedReason(restrictionDecisionReasons(verdict));

/** Why `verdict` cannot be recorded with this reason and note, or null when it can. */
export const restrictionRulingRefusal = (
  verdict: RestrictionVerdict,
  reason: string,
  note: string
): string | null => {
  const decision = RESTRICTION_DECISIONS.find((d) => d.verdict === verdict)!.label;
  return decisionReasonProblem('restriction', verdict, decision, reason, note);
};
