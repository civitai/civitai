import type { AliasKind } from '@civitai/moderation/model-rules';

export const ALIAS_KIND_LABELS: Record<AliasKind, string> = {
  stage_name: 'Stage name',
  other_script: 'Other script',
  romanization: 'Romanization',
  trigger_word: 'Trigger word',
  other: 'Other',
};

export type { AliasKind };

export type AliasSuggestion = { alias: string; kind: AliasKind; note?: string; source?: string };

export type SuggestAliasesResult = {
  suggested: true;
  suggestions: AliasSuggestion[];
  /** What the call cost, when the main app reported it. */
  costTotal?: number;
};
