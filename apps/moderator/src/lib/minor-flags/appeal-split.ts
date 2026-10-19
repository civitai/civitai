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
