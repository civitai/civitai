import { KNIGHTS_ESCALATION_REASONS } from '@civitai/shared/new-order';

/** `write-back` is the items whose settled rating could not be written to the image (`reason` is set), not an escalation. */
export const INQUISITOR_FILTERS = ['all', ...KNIGHTS_ESCALATION_REASONS, 'write-back'] as const;
export type InquisitorFilter = (typeof INQUISITOR_FILTERS)[number];

export const INQUISITOR_FILTER_LABELS: Record<InquisitorFilter, string> = {
  all: 'All',
  blocked: 'Reported blocked',
  'pushed-down': 'Pushed down',
  'no-consensus': 'No consensus',
  'write-back': 'Write-back conflict',
};

/** An unknown or absent value is the unfiltered queue, so a stale link still opens the page. */
export const parseInquisitorFilter = (value: string | null): InquisitorFilter =>
  INQUISITOR_FILTERS.find((filter) => filter === value) ?? 'all';
