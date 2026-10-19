import {
  resolutionReasonsFor,
  type ResolutionReason,
  type ResolutionVerdict,
} from '@civitai/shared/resolution-reasons';
import { decisionReasonProblem } from '$lib/triage/decision-reasons';

/** What raised a flag or lead: an applied hash or text-scan flag (Auto-flagged), or a held detection
 *  or file match nothing was applied for (Needs review). */
export type FlaggedSource = 'hash' | 'redetected' | 'text-scan' | 'file-match';
export type FlaggedLabel = 'minor' | 'poi';

/** Key order: 1 keeps the flag, 2 lifts it. The main app refuses to keep a flag while the owner has an
 *  open appeal. A hash or text-scan row can still be lifted (the ruling settles the appeal); a
 *  re-detection is refused either way, so both keys go off. A file match is not tied to an appeal. */
export const flaggedDecisionEnabled = (row: {
  source: FlaggedSource;
  hasPendingAppeal: boolean;
}): readonly boolean[] =>
  row.source === 'file-match'
    ? [true, true]
    : [!row.hasPendingAppeal, !(row.hasPendingAppeal && row.source === 'redetected')];

/** One flag a Flagged row rules on: the label, what raised it, and the text a ruling is bound to. */
export type FlagRef = { label: FlaggedLabel; source: FlaggedSource; textHash: string | null };

/** A model carries at most one flag per label and source, so the pair names it within the row. */
export const flagRefId = (flag: Pick<FlagRef, 'label' | 'source'>) =>
  `${flag.label}:${flag.source}`;

export const FLAG_LABEL_NAMES: Record<FlaggedLabel, string> = {
  minor: 'minor',
  poi: 'real person',
};

/** A decision button: the flags it keeps; every other flag on the row is reverted. */
export type FlaggedDecision = { label: string; keep: string[]; key?: 1 | 2 };

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The decisions a row offers. Keys 1 and 2 confirm and revert every flag; with two labels, one split
 * per label keeps it and reverts the other. Two flags on the same label (a hash and a held minor) get
 * no split: "keep minor, revert minor" says nothing.
 */
export function flaggedDecisions(flags: readonly FlagRef[]): FlaggedDecision[] {
  const ids = flags.map(flagRefId);
  if (flags.length === 1)
    return [
      { label: `Confirm ${FLAG_LABEL_NAMES[flags[0].label]} flag`, keep: ids, key: 1 },
      { label: 'Revert flag', keep: [], key: 2 },
    ];
  const all: FlaggedDecision[] = [
    { label: flags.length === 2 ? 'Confirm both flags' : 'Confirm all flags', keep: ids, key: 1 },
    { label: flags.length === 2 ? 'Revert both' : 'Revert all', keep: [], key: 2 },
  ];
  if (new Set(flags.map((f) => f.label)).size !== flags.length) return all;
  const splits = flags.map((kept) => ({
    label: capitalise(
      flags.map((f) => `${f === kept ? 'keep' : 'revert'} ${FLAG_LABEL_NAMES[f.label]}`).join(', ')
    ),
    keep: [flagRefId(kept)],
  }));
  return [...all, ...splits];
}

/**
 * Needs review's decisions: nothing is applied yet, so 1 flags every lead and 2 flags none ("Dismiss
 * match" when the row is only a file match). With two labels, one split per label flags only it.
 */
export function needsReviewDecisions(flags: readonly FlagRef[]): FlaggedDecision[] {
  const ids = flags.map(flagRefId);
  const labels = [...new Set(flags.map((f) => FLAG_LABEL_NAMES[f.label]))];
  const onlyMatches = flags.every((f) => f.source === 'file-match');
  const all: FlaggedDecision[] = [
    { label: `Flag as ${labels.join(' and ')}`, keep: ids, key: 1 },
    { label: onlyMatches ? 'Dismiss match' : "Don't flag", keep: [], key: 2 },
  ];
  if (flags.length < 2 || labels.length !== flags.length) return all;
  return [
    ...all,
    ...flags.map((f) => ({
      label: `Flag as ${FLAG_LABEL_NAMES[f.label]} only`,
      keep: [flagRefId(f)],
    })),
  ];
}

/** Whether every flag allows its part of the decision (see `flaggedDecisionEnabled`). */
export const decisionEnabled = (
  flags: readonly (FlagRef & { hasPendingAppeal: boolean })[],
  decision: Pick<FlaggedDecision, 'keep'>
) =>
  flags.every((flag) => {
    const [keepOk, liftOk] = flaggedDecisionEnabled(flag);
    return decision.keep.includes(flagRefId(flag)) ? keepOk : liftOk;
  });

/** The kept ids a decision button posted, or null when it names a flag the form does not carry. */
export function parseKeptIds(raw: unknown, flags: readonly FlagRef[]): string[] | null {
  if (typeof raw !== 'string') return null;
  const ids = raw.split(',').filter(Boolean);
  const known = new Set(flags.map(flagRefId));
  return ids.every((id) => known.has(id)) ? [...new Set(ids)] : null;
}

export type PlannedFlag = FlagRef & { keep: boolean };

export const planDecision = (flags: readonly FlagRef[], keep: readonly string[]): PlannedFlag[] =>
  flags.map((flag) => ({ ...flag, keep: keep.includes(flagRefId(flag)) }));

/** The reason list and verdict a flag's ruling records under; a hash flag records none (its main-app
 *  endpoints take no reason yet). Both lists are the same, so one select serves every source. */
export type FlagRuling =
  | { subject: 'flagReview'; verdict: ResolutionVerdict<'flagReview'> }
  | { subject: 'heldDetection'; verdict: ResolutionVerdict<'heldDetection'> };

export function flagRuling(flag: Pick<PlannedFlag, 'source' | 'keep'>): FlagRuling | null {
  if (flag.source === 'text-scan')
    return { subject: 'flagReview', verdict: flag.keep ? 'Kept' : 'Lifted' };
  if (flag.source === 'redetected')
    return { subject: 'heldDetection', verdict: flag.keep ? 'Kept' : 'Dismissed' };
  return null;
}

/** Runs `run` with the ruling's subject and verdict typed as a pair. The reason helpers are generic in
 *  the subject, which a union value cannot satisfy in one call, so the narrowing lives here once. */
export const withRuling = <T>(
  ruling: FlagRuling,
  run: <S extends FlagRuling['subject']>(subject: S, verdict: ResolutionVerdict<S>) => T
): T =>
  ruling.subject === 'flagReview'
    ? run(ruling.subject, ruling.verdict)
    : run(ruling.subject, ruling.verdict);

/** In a split the picked reason explains the revert; the kept flag records that its detection was
 *  correct, which is what keeping it asserts. */
export const SPLIT_KEPT_REASON = 'detection-correct';

const isSplit = (plan: readonly PlannedFlag[]) =>
  plan.some((f) => f.keep) && plan.some((f) => !f.keep);

export const decisionReasonFor = (
  plan: readonly PlannedFlag[],
  flag: PlannedFlag,
  reason: string
) => (flag.keep && isSplit(plan) ? SPLIT_KEPT_REASON : reason);

/** Why this decision cannot be recorded with the bar's reason and note, or null. Each reasoned flag
 *  checks the reason against its own label, so a reason must fit every label it is recorded on. */
export function planReasonProblem(
  plan: readonly PlannedFlag[],
  decisionLabel: string,
  reason: string,
  note: string
): string | null {
  for (const flag of plan) {
    const ruling = flagRuling(flag);
    if (!ruling) continue;
    const problem = withRuling(ruling, (subject, verdict) =>
      decisionReasonProblem(
        subject,
        verdict,
        decisionLabel,
        decisionReasonFor(plan, flag, reason),
        note,
        [flag.label]
      )
    );
    if (problem) return problem;
  }
  return null;
}

/** The reasons the bar's select offers for keeping or reverting these flags, or null when none of
 *  them records a reason. */
export function flaggedReasonGroups(
  flags: readonly FlagRef[],
  labels: { keep: string; revert: string }
): { label: string; reasons: readonly ResolutionReason[] }[] | null {
  const reasoned = flags.filter((f) => flagRuling({ source: f.source, keep: true }) !== null);
  if (!reasoned.length) return null;
  const list = (keep: boolean) => {
    const seen = new Map<string, ResolutionReason>();
    for (const flag of reasoned) {
      const ruling = flagRuling({ source: flag.source, keep })!;
      const reasons = withRuling(ruling, (subject, verdict) =>
        resolutionReasonsFor(subject, verdict, [flag.label])
      );
      for (const r of reasons) if (!seen.has(r.value)) seen.set(r.value, r);
    }
    return [...seen.values()];
  };
  return [
    { label: labels.keep, reasons: list(true) },
    { label: labels.revert, reasons: list(false) },
  ];
}
