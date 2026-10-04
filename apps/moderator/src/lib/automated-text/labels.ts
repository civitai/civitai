/**
 * The answer a labeler gives for one (report, tag) pair on the automated text relabel page. The four
 * values are the ticket's vocabulary verbatim, so the set doubles as the decision-model eval's gold.
 * They are STORED values: renaming one orphans every answer already recorded under it.
 */
export const TEXT_LABELS = [
  {
    value: 'clear_violation',
    label: 'Clear violation',
    hint: 'States or promotes what the tag names',
  },
  { value: 'borderline', label: 'Borderline', hint: 'Could reasonably be read either way' },
  {
    value: 'false_positive',
    label: 'False positive',
    hint: 'Matches a keyword but is benign: quoting, reporting, a joke, a model name',
  },
  {
    value: 'cannot_tell',
    label: 'Cannot tell',
    hint: 'Too short, or missing the context to judge',
  },
] as const;

export type TextLabel = (typeof TEXT_LABELS)[number]['value'];

const LABEL_VALUES: ReadonlySet<string> = new Set(TEXT_LABELS.map((l) => l.value));

export const parseTextLabel = (raw: unknown): TextLabel | null =>
  typeof raw === 'string' && LABEL_VALUES.has(raw) ? (raw as TextLabel) : null;

export const MAX_NOTE_LENGTH = 1000;

/**
 * A labeler's clear_violation on one of these tags is a live case, not only a label: the page hands it
 * to the existing report and lookup pages instead of moving on. Which tags belong here is a product
 * decision; Sex Trafficking and Exploitation are the obvious candidates to add.
 */
export const HAND_OFF_TAGS: ReadonlySet<string> = new Set(['CSAM', 'Grooming']);

export const needsHandOff = (tag: string, label: TextLabel): boolean =>
  label === 'clear_violation' && HAND_OFF_TAGS.has(tag);
