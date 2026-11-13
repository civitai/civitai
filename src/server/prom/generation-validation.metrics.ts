import { registerCounterWithLabels } from '@civitai/telemetry/client';
import { GENERATION_SURFACES } from '~/shared/generation/model-substitution';

/**
 * Generation parses the hub REFUSED, by surface, workflow and the first failing field.
 *
 * 🔴 WHY THIS EXISTS, AND WHAT ITS BASELINE IS. `validateInput` is the single choke point
 * every server-side generation parse passes through, and on failure it threw a 400 and
 * recorded nothing. That was survivable while the data-graph shadow-compared every parse: a
 * hub refusal showed up as a `diverged` event with the field keys. Removing that lane removed
 * the only signal, for the one population the removal changes — a caller whose context carries
 * no `formGraphGenerator` flag was served the DATA-GRAPH result until now, and the App Blocks
 * bridge passes no flags.
 *
 * Measured over the 14 days before the cutover, across ~2,400 recorded disagreements: the hub
 * uniquely refused **nothing**, threw nothing, and whenever both engines failed they failed on
 * the same fields. So this counter's expected value is ZERO and a sustained non-zero on any
 * surface — `block` above all — is new behaviour rather than noise. That is the alarm.
 *
 * 🔴 WHICH CALLERS CAN REACH IT. Not the on-site form, in the ordinary case: `FormFooter`
 * calls `store.validate()` and RETURNS before any network call, so a form-detectable problem
 * never becomes a server parse. The populations that land here are the App Blocks bridge, the
 * bearer-token API, server-composed presets, and the narrow on-site case where the client
 * passed and the server refused — a genuine client/server divergence, which is the most
 * interesting reading this counter has. A zero on `surface="onsite"` therefore means "the
 * client caught it first", NOT "the form submits nothing invalid".
 *
 * 🔴 BOUNDED, AND KEPT THAT WAY. `workflow` arrives pre-parse, so it is an arbitrary caller
 * string and MUST be clamped to the known set before it becomes a label; `field` is a graph
 * key, never a value (an error message embeds the received value and must not reach a label);
 * `surface` is the four-value union plus `unknown`, for a caller that built no substitution
 * collector. An unclamped workflow or a raw message here is an unbounded label set, which is
 * the one way this counter could hurt rather than help.
 */
export const generationValidationRefusedCounter = registerCounterWithLabels({
  name: 'generation_validation_refused_total',
  help: 'Server-side generation parses refused by the hub, by surface, workflow and first failing field',
  labelNames: ['surface', 'workflow', 'field'] as const,
});

/**
 * Publish one zero-valued series per surface so a scrape can tell a real zero from an absent
 * instrument.
 *
 * This counter's healthy state IS zero, and the callers that can increment it are all
 * non-browser (see above), so "absent" is the expected reading for long stretches — and
 * absent is indistinguishable from "no pod has loaded the module yet", which is precisely
 * the ambiguity that makes an alarm on non-zero unverifiable. The same reasoning, and the
 * same remedy, as `civitai_generation_model_substitutions_total` (#3665).
 *
 * 🔴 SURFACE ONLY, not the full product. That counter can seed everything because 12 series
 * is its entire budget; this one is surface × ~40 workflows × the graph's key set, so seeding
 * it whole would manufacture hundreds of series to prove a negative. Five is enough: the alarm
 * is per surface, and the sentinel `none` for the other two labels cannot collide with a real
 * emit, which always carries a clamped workflow and a real field key.
 *
 * 🔴 SEEDING ALONE IS NOT ENOUGH. Nothing calls this except `src/pages/api/metrics.ts`; the
 * only production path into the counter itself is a refusal, which by definition has already
 * happened. Both halves are required and neither works alone — the lesson the substitution
 * metric's own comment records after shipping without the second one.
 *
 * Idempotent: `inc(…, 0)` is a no-op on an already-materialised series, so calling it on
 * every scrape cannot reset or double-count anything.
 */
export function seedGenerationValidationMetrics(): void {
  for (const surface of GENERATION_SURFACES) {
    generationValidationRefusedCounter.inc({ surface, workflow: 'none', field: 'none' }, 0);
  }
}
