import type { ModelRuleReference } from '@civitai/moderation/model-rules';

export const MODEL_RULE_HOLD_STATUSES = ['pending', 'confirmed', 'dismissed', 'all'] as const;
export const MODEL_RULE_HOLD_MODES = ['all', 'review', 'auto'] as const;
export const MODEL_RULE_HOLD_SORTS = ['oldest', 'newest'] as const;

export type ModelRuleHoldStatusFilter = (typeof MODEL_RULE_HOLD_STATUSES)[number];
export type ModelRuleHoldModeFilter = (typeof MODEL_RULE_HOLD_MODES)[number];
export type ModelRuleHoldSort = (typeof MODEL_RULE_HOLD_SORTS)[number];

export type ModelRuleHoldFilters = {
  status: ModelRuleHoldStatusFilter;
  mode: ModelRuleHoldModeFilter;
  sort: ModelRuleHoldSort;
  /** Only holds that matched this rule. */
  rule: number | null;
};

export const DEFAULT_MODEL_RULE_HOLD_FILTERS: ModelRuleHoldFilters = {
  status: 'pending',
  mode: 'all',
  sort: 'oldest',
  rule: null,
};

export const MODEL_RULE_HOLD_STATUS_LABELS: Record<ModelRuleHoldStatusFilter, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  dismissed: 'Dismissed',
  all: 'All',
};
export const MODEL_RULE_HOLD_MODE_LABELS: Record<ModelRuleHoldModeFilter, string> = {
  all: 'All',
  review: 'Review',
  auto: 'Auto',
};
export const MODEL_RULE_HOLD_SORT_LABELS: Record<ModelRuleHoldSort, string> = {
  oldest: 'Oldest first',
  newest: 'Newest first',
};

export const modelRuleHoldFilterParams = (
  filters: ModelRuleHoldFilters
): Record<string, string> => {
  const params: Record<string, string> = {};
  for (const key of ['status', 'mode', 'sort'] as const)
    if (filters[key] !== DEFAULT_MODEL_RULE_HOLD_FILTERS[key]) params[key] = filters[key];
  if (filters.rule !== null) params.rule = String(filters.rule);
  return params;
};

/** Stored as the detection mode; the moderator sees Review (`shadow`) and Auto (`active`). */
export type HoldMode = 'shadow' | 'active';
export const modeLabel = (mode: HoldMode) => (mode === 'active' ? 'Auto' : 'Review');

export const modelStatusLabel = (status: string) =>
  status
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/ (\w)/g, (_, c: string) => ` ${c.toLowerCase()}`);

/** Mirrors the main app's `MODEL_RULES_HOLD_DECISIONS`. */
export const MODEL_RULE_HOLD_DECISIONS = [
  'confirm',
  'confirm_strike',
  'dismiss_not_subject',
  'dismiss_allowed',
] as const;
export type ModelRuleHoldDecision = (typeof MODEL_RULE_HOLD_DECISIONS)[number];

/** The action buttons' order, which is also the digit keys' (key `n + 1` picks index `n`). */
export const DECISION_KEY_ORDER = MODEL_RULE_HOLD_DECISIONS;

/** What a batch may decide: the strike is the owner's, applied with the hold the moderator is on. */
export const BATCH_DECISIONS: readonly ModelRuleHoldDecision[] = [
  'confirm',
  'dismiss_not_subject',
  'dismiss_allowed',
];

/** Mirrors the main app's `MODEL_RULES_HOLD_BATCH_MAX`. */
export const BATCH_MAX = 50;
export const NOTE_MAX_LENGTH = 500;

export const STRIKE_GRANT = 'user.strike';

export const expectedStatus = (decision: ModelRuleHoldDecision) =>
  decision === 'confirm' || decision === 'confirm_strike' ? 'Confirmed' : 'Dismissed';

/**
 * Whether a ruling clears the matched rules for the text instead of restoring the model: the condition
 * the main app's `clearsRulesInsteadOfRestoring` applies, so the copy promises what the server does.
 */
export function holdClearsRules(hold: {
  source: 'training' | null;
  modelStatus: string | null;
  modelAvailability: string | null;
  modelDeleted: boolean;
}): boolean {
  if (hold.modelStatus === null || hold.modelDeleted || hold.modelStatus === 'Deleted')
    return false;
  if (hold.source === 'training') return true;
  const live =
    (hold.modelStatus === 'Published' || hold.modelStatus === 'Scheduled') &&
    hold.modelAvailability !== 'Private';
  return !live && hold.modelStatus !== 'UnpublishedViolation';
}

/** The button copy follows what the decision does to the model in the mode the hold was detected in. */
export function decisionButtons(
  mode: HoldMode,
  clearsRules = false
): {
  decision: ModelRuleHoldDecision;
  label: string;
  tone?: 'red' | 'dark-red';
}[] {
  const auto = mode === 'active';
  return [
    {
      decision: 'confirm',
      label: clearsRules ? 'Confirm' : auto ? 'Confirm — keep down' : 'Confirm — unpublish',
      tone: 'red',
    },
    {
      decision: 'confirm_strike',
      label: clearsRules
        ? 'Confirm + strike'
        : auto
        ? 'Confirm — keep down + strike'
        : 'Confirm — unpublish + strike',
      tone: 'dark-red',
    },
    {
      decision: 'dismiss_not_subject',
      label:
        auto && !clearsRules
          ? 'Dismiss — republish (not this subject)'
          : 'Dismiss — not this subject',
    },
    {
      decision: 'dismiss_allowed',
      label: auto && !clearsRules ? 'Dismiss — republish (allowed use)' : 'Dismiss — allowed use',
    },
  ];
}

export function decisionOutcome(
  decision: ModelRuleHoldDecision,
  mode: HoldMode,
  clearsRules = false
): string {
  const auto = mode === 'active';
  if (clearsRules) {
    if (decision === 'confirm') return 'Confirmed';
    if (decision === 'confirm_strike') return 'Confirmed, owner struck';
    return 'Dismissed — cleared for this text';
  }
  if (decision === 'confirm') return auto ? 'Model kept down' : 'Model unpublished';
  if (decision === 'confirm_strike')
    return auto ? 'Model kept down, owner struck' : 'Model unpublished, owner struck';
  return auto ? 'Dismissed — model republished' : 'Dismissed';
}

export function holdDecisionEnabled(
  hold: { status: string; userId: number | null },
  grants: { canStrike: boolean }
): boolean[] {
  if (hold.status !== 'Pending') return [];
  return DECISION_KEY_ORDER.map((decision) =>
    decision === 'confirm_strike' ? grants.canStrike && hold.userId !== null : true
  );
}

/** What a decided hold shows in the queue, from its stored decision and the mode it was detected in. */
export function heldOutcome(hold: {
  status: string;
  decision: string | null;
  mode: HoldMode;
  clearsRules?: boolean;
}): string {
  if (hold.decision && (MODEL_RULE_HOLD_DECISIONS as readonly string[]).includes(hold.decision))
    return decisionOutcome(hold.decision as ModelRuleHoldDecision, hold.mode, hold.clearsRules);
  return hold.status === 'Confirmed' ? 'Confirmed' : 'Dismissed';
}

export const MODEL_RULE_MATCHES_PATH = '/models/rule-matches';

/** The text of a rule's reference link: its label, else the site it points at. */
export function referenceText(reference: ModelRuleReference): string {
  if (reference.label) return reference.label;
  try {
    return new URL(reference.url).hostname.replace(/^www\./, '');
  } catch {
    return reference.url;
  }
}
