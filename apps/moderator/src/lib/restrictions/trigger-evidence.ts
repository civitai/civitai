import type { RestrictionTrigger } from '$lib/server/user-restriction.service';

export type TriggerField = 'prompt' | 'negativePrompt';

export type ExplainedMatch = {
  category?: string;
  /** The literal span found, preferring the recorded span over the rule's word. */
  text?: string;
  regex?: string;
  field?: TriggerField;
  gateWord?: string;
};

type MatchSource = Pick<
  RestrictionTrigger,
  | 'prompt'
  | 'category'
  | 'matchedWord'
  | 'matchedRegex'
  | 'matchedText'
  | 'matchedField'
  | 'gateWord'
  | 'matches'
>;

const SOURCE_LABELS: Record<string, string> = {
  Regex: 'Word list',
  External: 'External moderation',
};

export const sourceLabel = (source: string): string => SOURCE_LABELS[source] ?? source;

export function humanizeCategory(category: string): string {
  const words = category
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const fieldLabel = (field: TriggerField): string =>
  field === 'prompt' ? 'prompt' : 'negative prompt';

/** Rows written before the evidence fields existed carry only the top-level match, if any. */
export function explainMatches(trigger: MatchSource): ExplainedMatch[] {
  const raw = trigger.matches?.length
    ? trigger.matches
    : trigger.category || trigger.matchedWord || trigger.matchedText
      ? [trigger]
      : [];
  return raw.map((m) => ({
    category: m.category || undefined,
    text: m.matchedText || m.matchedWord || undefined,
    regex: m.matchedRegex || undefined,
    field: m.matchedField,
    gateWord: m.gateWord || undefined,
  }));
}

/** Literal strings to highlight per box. A match with no recorded field marks both boxes; a gate
 *  word is NSFW-list text from the prompt. */
export function highlightSets(matches: ExplainedMatch[]): Record<TriggerField, string[]> {
  const sets: Record<TriggerField, Set<string>> = {
    prompt: new Set(),
    negativePrompt: new Set(),
  };
  for (const m of matches) {
    if (m.text) {
      if (m.field !== 'negativePrompt') sets.prompt.add(m.text);
      if (m.field !== 'prompt') sets.negativePrompt.add(m.text);
    }
    if (m.gateWord) sets.prompt.add(m.gateWord);
  }
  return { prompt: [...sets.prompt], negativePrompt: [...sets.negativePrompt] };
}

/** A prompt was stored but nothing says why it was blocked. */
export function hasNoRecordedMatch(trigger: MatchSource): boolean {
  return !!trigger.prompt && explainMatches(trigger).length === 0;
}

export function promptTesterHref(input: { prompt: string; negativePrompt?: string }): string {
  const params = new URLSearchParams({ prompt: input.prompt });
  if (input.negativePrompt) params.set('negativePrompt', input.negativePrompt);
  return `/audit/prompt-tester?${params}`;
}
