import type { FlagLabel } from './text-scan-verdicts';

type Decision = 'uphold' | 'overturn';

/** The split appeal rulings: each keeps one flag and lifts the other. */
export const APPEAL_SPLITS = {
  liftPoi: { minor: 'uphold', poi: 'overturn', lifted: 'poi' },
  liftMinor: { minor: 'overturn', poi: 'uphold', lifted: 'minor' },
} as const satisfies Record<string, { minor: Decision; poi: Decision; lifted: FlagLabel }>;

export type AppealSplit = keyof typeof APPEAL_SPLITS;

export const isAppealSplit = (value: unknown): value is AppealSplit =>
  typeof value === 'string' && Object.hasOwn(APPEAL_SPLITS, value);

/** Sets `minor` and `poi` from the split named by the posted `ruling`. A split button posts only its
 *  own name and value, so this is what makes a submit before hydration carry both decisions. */
export function withSplitDecisions(form: FormData): FormData {
  const ruling = form.get('ruling');
  if (isAppealSplit(ruling)) {
    form.set('minor', APPEAL_SPLITS[ruling].minor);
    form.set('poi', APPEAL_SPLITS[ruling].poi);
  }
  return form;
}

/** The appeal verdict a set of per-label decisions amounts to: none lifted rejects it, any lifted
 *  approves it (`lifted` names them), and `perLabel` is set only when the labels differ. A label left
 *  out of `decisions` is not on the ruling and, where `perLabel` is needed, counts as overturned. */
export function appealVerdict(decisions: Partial<Record<FlagLabel, Decision>>) {
  const present = Object.keys(decisions) as FlagLabel[];
  const lifted = present.filter((label) => decisions[label] === 'overturn');
  const verdict = lifted.length ? ('Approved' as const) : ('Rejected' as const);
  const mixed = lifted.length > 0 && lifted.length < present.length;
  const perLabel = mixed
    ? { minor: decisions.minor ?? 'overturn', poi: decisions.poi ?? 'overturn' }
    : null;
  return { verdict, lifted, perLabel } as {
    verdict: 'Rejected' | 'Approved';
    lifted: FlagLabel[];
    perLabel: { minor: Decision; poi: Decision } | null;
  };
}
