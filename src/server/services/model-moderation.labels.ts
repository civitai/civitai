// A leaf module so the version adapter can read these without importing the model adapter.
// That edge closed a cycle — model-moderation.adapter → … → model-version.service →
// model-version-moderation.adapter → model-moderation.adapter — which typecheck and the unit
// suites do not see: it only breaks when a process happens to load the model adapter first,
// which is how a one-off script found it.

/**
 * Every label submitted on a model scan. Twelve of them are recorded and not acted on —
 * their trigger rates on real model text are the input to deciding what a v2 acts on, and
 * there is no way to collect them without scanning.
 *
 * Owned by the model path rather than imported from another consumer: per-consumer label
 * selection is the pattern (Article sends one, Challenge two, wildcard a fail set plus a level
 * set), and importing App Blocks' list would couple two sets that are allowed to diverge.
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
