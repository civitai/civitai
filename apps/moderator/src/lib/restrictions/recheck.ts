import type { PromptHighlightCategory, PromptSegment } from '@civitai/mod-utils/prompt-audit';
import type { RestrictionTrigger } from '$lib/server/user-restriction.service';
import { hasNoRecordedMatch } from './trigger-evidence';

export type RecheckResult = {
  prompt: PromptSegment[];
  negativePrompt: PromptSegment[] | null;
  /** Whether the current audit would hard-block this prompt, as opposed to merely flagging terms. */
  wouldBlock: boolean;
};

export const RECHECK_BLOCKS = 'Would block now';
export const RECHECK_NOT_BLOCKING = 'Would not block now';

/** Highlighted terms alone do not block; only the audit's own verdict or a blocked-list hit does. */
export function recheckResult(audit: {
  includesInappropriate: boolean;
  prompt: PromptSegment[];
  negativePrompt: PromptSegment[] | null;
}): RecheckResult {
  const { prompt, negativePrompt } = audit;
  const blocked = [...prompt, ...(negativePrompt ?? [])].some((s) => s.category === 'blocked');
  return { prompt, negativePrompt, wouldBlock: audit.includesInappropriate || blocked };
}

/** Summary labels for one re-checked trigger; empty means the re-check found nothing. */
export function recheckReasonLabels(
  result: RecheckResult,
  categoryName: (category: PromptHighlightCategory) => string
): string[] {
  const categories = recheckCategories(result);
  if (!categories.length && !result.wouldBlock) return [];
  if (!result.wouldBlock) return [RECHECK_NOT_BLOCKING];
  return [
    categories.length
      ? `${RECHECK_BLOCKS} (${categories.map(categoryName).join(', ')})`
      : RECHECK_BLOCKS,
  ];
}

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

export function recheckCategories(
  result: Pick<RecheckResult, 'prompt' | 'negativePrompt'>
): PromptHighlightCategory[] {
  const found = new Set<PromptHighlightCategory>();
  for (const segment of [...result.prompt, ...(result.negativePrompt ?? [])]) {
    if (segment.category) found.add(segment.category);
  }
  return [...found];
}

/** Segments are of normalised text; only offer the original when the two actually differ. */
export function normalisedDiffers(segments: readonly PromptSegment[], raw: string): boolean {
  return segments.map((s) => s.text).join('') !== raw;
}

/** Re-checked triggers the current word list would not block, including ones it finds nothing in. */
export function countNotBlocking(recheck: Recheck | undefined): number {
  if (!recheck) return 0;
  return Object.values(recheck.byKey).filter((i) => !recheck.results[i]?.wouldBlock).length;
}
