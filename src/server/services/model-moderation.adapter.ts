import { removeTags } from '~/utils/string-helpers';

export const MODEL_MODERATION_ENTITY_TYPE = 'Model';

/**
 * Every label submitted on a model scan. Twelve of them are recorded and not acted on —
 * their trigger rates on real model text are the input to deciding what a v2 acts on, and
 * there is no way to collect them without scanning.
 *
 * Owned here rather than imported from `blocks/steps/text-output-moderation`: per-consumer
 * label selection is the pattern (Article sends one, Challenge two, wildcard a fail set plus
 * a level set), and importing that list would point a dependency at App Blocks.
 */
export const MODEL_MODERATION_SCAN_LABELS = [
  'NSFW',
  'Suggestive',
  'Explicit',
  'Young',
  'Grooming',
  'Sex Trafficking',
  'Exploitation',
  'Extremism',
  'Impersonating Civitai Staff',
  'Bestiality',
  'Urine',
  'Diaper',
  'Scat',
  'Menstruation',
  'Celebrity',
] as const;

/** Triggering any of these sets `nsfw = true`. Lowercase — comparisons normalize both sides. */
export const MODEL_MODERATION_LEVEL_LABELS = ['nsfw', 'suggestive', 'explicit'] as const;

const LEVEL_LABEL_SET: ReadonlySet<string> = new Set(MODEL_MODERATION_LEVEL_LABELS);

/**
 * The single definition of the scanned string.
 *
 * The submit path, `resolveContent`, and the backfill all call this. A second copy that
 * drifts breaks `contentHash` dedup silently — the retry cron re-audits already-scanned
 * models forever and nothing reports an error.
 */
export function buildModelModerationText(model: {
  name: string;
  description?: string | null;
}): string {
  return [model.name, model.description ? removeTags(model.description) : null]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isModelTextNsfw({ triggeredLabels }: { triggeredLabels?: string[] }): boolean {
  return (triggeredLabels ?? []).some((label) => LEVEL_LABEL_SET.has(label.toLowerCase()));
}
