import { registerCounterWithLabels } from '@civitai/telemetry/client';

/**
 * MODEL TEXT MODERATION outcome metrics — the ramp's operating surface.
 *
 * ## Why this exists
 *
 * `scanner_label_results` already records what XGuard *said* about every scan:
 * per-label score, threshold, triggered, policy version. That is the input to the
 * ramp decision and it needs no help.
 *
 * What nothing records is what we *did about it*. The apply path's four outcomes
 * are mutually exclusive and, from outside, indistinguishable — a model that was
 * flagged, one that lost a race to a moderator, one that was already locked, and
 * one whose level was merely repaired all leave the same trace: a `Succeeded`
 * EntityModeration row. So "the flag rate jumped at 25%" and "the flag rate looks
 * normal but half of them are being declined" read identically, and they need
 * opposite responses.
 *
 * During a percentage ramp that is the difference between noticing a problem and
 * finding out from a creator.
 *
 * ## The signal
 *
 * `civitai_app_model_text_moderation_outcome_total{outcome}` — one increment per
 * callback that reached the apply stage, i.e. after a level label triggered and
 * the apply flag allowed the write. FOUR series, fixed:
 *
 *   - `applied`        — the model was flagged. This is the rate to watch against
 *                        the ramp percentage; it should scale roughly linearly.
 *   - `skipped_locked` — a moderator had already ruled. Expected and healthy; a
 *                        rising share means the sweep is re-treading decided models.
 *   - `repaired`       — an earlier callback flagged the model but died before
 *                        recomputing its level. Should be near zero. Sustained
 *                        non-zero means callbacks are dying mid-apply.
 *   - `declined_race`  — a lock landed between our read and our write. Should be
 *                        vanishingly rare; a spike means moderators and the scanner
 *                        are contending for the same models.
 *
 * Deliberately NOT labelled by model or by label name: model id is unbounded
 * cardinality, and which label fired is already in the audit log, joinable by
 * entity. This counter answers rate-and-outcome questions only.
 */
export const modelTextModerationOutcomeCounter = registerCounterWithLabels({
  name: 'model_text_moderation_outcome_total',
  help: 'Model text-moderation callbacks that reached the apply stage, by what the adapter did (applied, skipped_locked, repaired, declined_race)',
  labelNames: ['outcome'] as const,
});

export type ModelTextModerationOutcome =
  | 'applied'
  | 'skipped_locked'
  | 'repaired'
  | 'declined_race';

/** Never let a metrics failure take down a moderation callback. */
export function recordModelTextModerationOutcome(outcome: ModelTextModerationOutcome) {
  try {
    modelTextModerationOutcomeCounter.inc({ outcome });
  } catch {
    // no-op
  }
}
