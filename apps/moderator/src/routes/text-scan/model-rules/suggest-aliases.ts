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

/** What a submit or a poll returned: the search is still running, or finished with these. */
export type SuggestAliasesResult =
  | { suggested: true; status: 'pending'; workflowId: string }
  | {
      suggested: true;
      status: 'done';
      suggestions: AliasSuggestion[];
      /** What the call cost, when the main app reported it. */
      costTotal?: number;
    };

export type AliasResultAnswer =
  | { suggested: true; status: 'pending' }
  | Extract<SuggestAliasesResult, { status: 'done' }>
  | { suggested: true; status: 'failed'; error: string };
