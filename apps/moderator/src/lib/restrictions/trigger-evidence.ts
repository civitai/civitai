import { utcMs } from '$lib/format';
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

/** Cold-seeded triggers carry ClickHouse's unzoned UTC timestamps, which `Date` reads as local. */
export function isoTriggerTime(time: string | undefined): string | undefined {
  if (!time) return time;
  const ms = utcMs(time);
  return Number.isNaN(ms) ? time : new Date(ms).toISOString();
}

/** Rows written before the evidence fields existed carry only the top-level match, if any. */
export function explainMatches(trigger: MatchSource): ExplainedMatch[] {
  const raw = trigger.matches?.length
    ? trigger.matches
    : trigger.category ||
      trigger.matchedWord ||
      trigger.matchedText ||
      trigger.matchedRegex ||
      trigger.gateWord
    ? [trigger]
    : [];
  return raw.map((m) =>
    // External moderation stores its classifier label in matchedWord; it is not prompt text.
    m.category?.toLowerCase() === 'external'
      ? { category: m.matchedWord || m.category }
      : {
          category: m.category || undefined,
          text: m.matchedText || m.matchedWord || undefined,
          regex: m.matchedRegex || undefined,
          field: m.matchedField,
          gateWord: m.gateWord || undefined,
        }
  );
}

/** A match with no recorded field marks both boxes; a gate word is always from the prompt. */
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

export function hasNoRecordedMatch(trigger: MatchSource): boolean {
  return !!trigger.prompt && explainMatches(trigger).length === 0;
}

/** Past this the link carries no prefill; very long URLs risk being dropped. */
export const MAX_PREFILL_URL_LENGTH = 6000;

export function promptTesterHref(input: { prompt: string; negativePrompt?: string }): {
  href: string;
  prefilled: boolean;
} {
  const base = '/audit/prompt-tester';
  const params = new URLSearchParams({ prompt: input.prompt });
  if (input.negativePrompt) params.set('negativePrompt', input.negativePrompt);
  const query = params.toString();
  if (query.length > MAX_PREFILL_URL_LENGTH) return { href: base, prefilled: false };
  return { href: `${base}?${query}`, prefilled: true };
}

/** The tester reads input starting with `[` as a JSON array, so such a prompt must be sent as one. */
export function prefillInput(prompt: string, negativePrompt?: string | null): string {
  if (!negativePrompt && !prompt.trim().startsWith('[')) return prompt;
  return JSON.stringify([negativePrompt ? { prompt, negativePrompt } : { prompt }], null, 2);
}

export function isMissingFromText(
  match: Pick<ExplainedMatch, 'text' | 'field'>,
  texts: { prompt?: string; negativePrompt?: string }
): boolean {
  if (!match.text) return false;
  const needle = match.text.toLowerCase();
  const fields: TriggerField[] = match.field ? [match.field] : ['prompt', 'negativePrompt'];
  return !fields.some((f) => (texts[f] ?? '').toLowerCase().includes(needle));
}
