import type { PromptHighlightCategory, PromptSegment } from '@civitai/mod-utils/prompt-audit';
import type { RestrictionTrigger } from '$lib/server/user-restriction.service';
import { hasNoRecordedMatch } from './trigger-evidence';

export type RecheckResult = {
  prompt: PromptSegment[];
  negativePrompt: PromptSegment[] | null;
};

/** `byKey` indexes `results`, so a user who retried one prompt 89 times ships its segments once. */
export type Recheck = {
  results: RecheckResult[];
  byKey: Record<string, number>;
};

type Plannable = Pick<RestrictionTrigger, 'prompt' | 'negativePrompt' | 'source'> &
  Parameters<typeof hasNoRecordedMatch>[0] & { key: string };

/** External moderation judged the content itself, so the word lists have nothing to say about it. */
export function planRecheck(triggers: readonly Plannable[]): {
  inputs: { prompt: string; negativePrompt?: string }[];
  byKey: Record<string, number>;
} {
  const inputs: { prompt: string; negativePrompt?: string }[] = [];
  const byKey: Record<string, number> = {};
  const seen = new Map<string, number>();
  for (const trigger of triggers) {
    if (trigger.source === 'External' || !hasNoRecordedMatch(trigger)) continue;
    const prompt = trigger.prompt!;
    const negativePrompt = trigger.negativePrompt || undefined;
    const id = JSON.stringify([prompt, negativePrompt ?? '']);
    let index = seen.get(id);
    if (index === undefined) {
      index = inputs.push(negativePrompt ? { prompt, negativePrompt } : { prompt }) - 1;
      seen.set(id, index);
    }
    byKey[trigger.key] = index;
  }
  return { inputs, byKey };
}

export function recheckCategories(result: RecheckResult): PromptHighlightCategory[] {
  const found = new Set<PromptHighlightCategory>();
  for (const segment of [...result.prompt, ...(result.negativePrompt ?? [])]) {
    if (segment.category) found.add(segment.category);
  }
  return [...found];
}
