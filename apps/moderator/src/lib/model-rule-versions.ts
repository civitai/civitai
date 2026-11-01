import type { ModelRuleReference } from '@civitai/moderation/model-rules';

/** One recorded state of a Model rule, as the history drawer shows it. */
export type ModelRuleVersionView = {
  id: number;
  legacy: boolean;
  subject: string;
  description: string;
  aliases: string[];
  category?: string;
  references: ModelRuleReference[];
  note: string;
  enabled: boolean;
  needsAttention: boolean;
  createdById: number;
  createdBy: string | null;
  createdAt: string;
};

export type RuleStateView = {
  subject: string;
  description: string;
  aliases: readonly string[];
  category?: string;
  references?: readonly ModelRuleReference[];
  note: string;
  enabled: boolean;
  needsAttention?: boolean;
};

const referencesText = (references: RuleStateView['references']) =>
  (references ?? []).map((r) => (r.label ? `${r.label} — ${r.url}` : r.url)).join('\n');

export type RuleDiffRow = { field: string; before: string; after: string; changed: boolean };

export function ruleVersionDiff(from: RuleStateView, to: RuleStateView): RuleDiffRow[] {
  const rows: [string, string, string][] = [
    ['Subject', from.subject, to.subject],
    ['Description', from.description, to.description],
    ['Aliases', from.aliases.join('\n'), to.aliases.join('\n')],
    ['Category', from.category ?? '', to.category ?? ''],
    ['References', referencesText(from.references), referencesText(to.references)],
    ['Internal note', from.note, to.note],
    ['Enabled', from.enabled ? 'Yes' : 'No', to.enabled ? 'Yes' : 'No'],
    ['Needs attention', from.needsAttention ? 'Yes' : 'No', to.needsAttention ? 'Yes' : 'No'],
  ];
  return rows.map(([field, before, after]) => ({
    field,
    before,
    after,
    changed: before !== after,
  }));
}

export const sameRuleState = (a: RuleStateView, b: RuleStateView) =>
  ruleVersionDiff(a, b).every((row) => !row.changed);
