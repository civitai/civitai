import {
  KNIGHTS_ESCALATION_REASONS,
  type KnightsEscalationReason,
  type KnightsWritebackReason,
} from '@civitai/shared/new-order';

/** No `no-consensus` tab: Knights re-rates ratings instead, and legacy waiting items show under All. */
const TABBED_ESCALATION_REASONS = KNIGHTS_ESCALATION_REASONS.filter(
  (reason): reason is Exclude<KnightsEscalationReason, 'no-consensus'> => reason !== 'no-consensus'
);

/** 'write-back' filters on `reason` (a failed apply handed the item over); every other tab filters on `escalationReason`. */
export const INQUISITOR_FILTERS = ['all', ...TABBED_ESCALATION_REASONS, 'write-back'] as const;
export type InquisitorFilter = (typeof INQUISITOR_FILTERS)[number];

export const DEFAULT_INQUISITOR_FILTER: InquisitorFilter = 'all';

export const ESCALATION_REASON_LABELS: Record<KnightsEscalationReason, string> = {
  blocked: 'Reported blocked',
  'pushed-down': 'Pushed down',
  'no-consensus': 'No consensus',
};

export const WRITEBACK_REASON_LABELS: Record<KnightsWritebackReason, string> = {
  blocked: 'Blocked before write-back',
  'level-moved': 'Level moved',
  'moderator-locked': 'Moderator-locked',
  'attempts-exhausted': 'Write-back failed',
};

export const INQUISITOR_FILTER_LABELS: Record<InquisitorFilter, string> = {
  all: 'All',
  blocked: ESCALATION_REASON_LABELS.blocked,
  'pushed-down': ESCALATION_REASON_LABELS['pushed-down'],
  'write-back': 'Write-back conflict',
};

/** An unknown or absent value is the unfiltered queue, so a stale link still opens the page. */
export const parseInquisitorFilter = (value: string | null): InquisitorFilter =>
  INQUISITOR_FILTERS.find((filter) => filter === value) ?? DEFAULT_INQUISITOR_FILTER;
