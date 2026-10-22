export const ALIAS_KIND_LABELS = {
  stage_name: 'Stage name',
  other_script: 'Other script',
  romanization: 'Romanization',
  trigger_word: 'Trigger word',
  other: 'Other',
} as const;

export type AliasKind = keyof typeof ALIAS_KIND_LABELS;
export const ALIAS_KINDS = Object.keys(ALIAS_KIND_LABELS) as [AliasKind, ...AliasKind[]];

export type AliasSuggestion = { alias: string; kind: AliasKind; note?: string; source?: string };

export type SuggestAliasesResult = { suggested: true; suggestions: AliasSuggestion[] };
