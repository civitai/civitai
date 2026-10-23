import {
  reasonRequiresNote,
  resolutionReasonError,
  resolutionReasonLabel,
  resolutionReasonsFor,
  type ResolutionReason,
  type ResolutionSubject,
  type ResolutionVerdict,
  type TextScanLabel,
} from '@civitai/shared/resolution-reasons';

export type ReasonGroup = { label: string; reasons: readonly ResolutionReason[] };

/** One select's worth of reasons for a bar where the reason is picked before the decision. */
export type DecisionReasons = { groups: ReasonGroup[]; shared: ResolutionReason[] };

/**
 * The reasons of every decision, grouped under the decision's label. A reason that every decision
 * offers (Other) is listed once after the groups: one select cannot hold the same value twice.
 */
export function decisionReasonOptions(groups: readonly ReasonGroup[]): DecisionReasons {
  const inEvery = (value: string) => groups.every((g) => g.reasons.some((r) => r.value === value));
  const shared = (groups[0]?.reasons ?? []).filter((r) => groups.length > 1 && inEvery(r.value));
  const isShared = (r: ResolutionReason) => shared.some((s) => s.value === r.value);
  return {
    groups: groups.map((g) => ({ label: g.label, reasons: g.reasons.filter((r) => !isShared(r)) })),
    shared,
  };
}

/** The reason to preselect: the decision's only specific reason, or none when there is a choice. */
export function suggestedReason(reasons: readonly ResolutionReason[]): string {
  const specific = reasons.filter((r) => !reasonRequiresNote(r.value));
  return specific.length === 1 ? specific[0].value : '';
}

/**
 * Why `decision` cannot be recorded with the reason and note already in the bar, or null when it can.
 * The reason is picked before the decision here, so a reason for the other decision is the expected
 * mistake and is named in words rather than as a slug.
 */
export function decisionReasonProblem<S extends ResolutionSubject>(
  subject: S,
  verdict: ResolutionVerdict<S>,
  decision: string,
  reason: string,
  note: string,
  labels?: readonly TextScanLabel[]
): string | null {
  if (reason && !resolutionReasonsFor(subject, verdict).some((r) => r.value === reason))
    return `"${resolutionReasonLabel(
      reason
    )}" is not a reason to ${decision.toLowerCase()}. Pick a reason that fits.`;
  return resolutionReasonError(subject, verdict, reason, note, labels);
}
