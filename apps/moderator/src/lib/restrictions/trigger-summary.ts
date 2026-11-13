import type { RestrictionTrigger } from '$lib/server/user-restriction.service';
import { explainMatches, humanizeCategory, sourceLabel } from './trigger-evidence';

type Summarizable = Parameters<typeof explainMatches>[0] &
  Pick<RestrictionTrigger, 'source' | 'time'> & {
    key: string;
    negativePrompt?: string;
  };

export type Tally = { label: string; count: number };

export type TriggerSummary = {
  total: number;
  distinctPrompts: number;
  reasons: Tally[];
  sources: Tally[];
  /** ISO times of the earliest and latest trigger that recorded one. */
  first?: string;
  last?: string;
};

function tally(labels: Iterable<string>): Tally[] {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1));
}

/**
 * `recheckLabels` maps a trigger key to the categories the current word list found in it: absent means
 * no re-check ran for that trigger, an empty list means it ran and found nothing.
 */
export function summarizeTriggers(
  triggers: readonly Summarizable[],
  recheckLabels: Record<string, string[]> = {}
): TriggerSummary {
  const prompts = new Set<string>();
  const reasons: string[] = [];
  const times: number[] = [];

  for (const trigger of triggers) {
    if (trigger.prompt) prompts.add(JSON.stringify([trigger.prompt, trigger.negativePrompt || '']));

    const matches = explainMatches(trigger);
    if (matches.length) {
      const labels = matches.map((m) =>
        m.category ? humanizeCategory(m.category) : 'Uncategorised match'
      );
      reasons.push(...new Set(labels));
    } else if (!trigger.prompt) {
      reasons.push('Not a prompt');
    } else {
      const rechecked = recheckLabels[trigger.key];
      if (!rechecked) reasons.push('Match not recorded');
      else if (!rechecked.length) reasons.push('No match with the current list');
      else reasons.push(...rechecked);
    }

    const time = Date.parse(trigger.time ?? '');
    if (!Number.isNaN(time)) times.push(time);
  }

  return {
    total: triggers.length,
    distinctPrompts: prompts.size,
    reasons: tally(reasons),
    sources: tally(
      triggers.map((trigger) => (trigger.source ? sourceLabel(trigger.source) : 'Unknown source'))
    ),
    first: times.length ? new Date(Math.min(...times)).toISOString() : undefined,
    last: times.length ? new Date(Math.max(...times)).toISOString() : undefined,
  };
}
