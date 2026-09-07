// DARK SHADOW PROBE: does a CHEAPER classifier model agree with the one in production?
//
// WHY this exists. `MODERATION_MODEL` is `omni-moderation-latest`, the MULTIMODAL model, and these
// prompts are TEXT. Roughly 175-180 ms of the ~205 ms `moderatePrompt` costs is the model's own
// inference time, which makes it the largest single component of the call and the only one nobody
// has tried to move — every infra-side lever (tail clamping, connection reuse, overlapping the
// submit) was tested against production measurements and all three are dead.
//
// 🔴 BUT THE BLOCKER IS NOT LATENCY, IT IS QUALITY, AND THERE WAS NO INSTRUMENT FOR IT. The
// duration histogram in `~/server/prom/external-moderation.metrics` grades a candidate model's
// SPEED within one scrape. It cannot express whether that model AGREES with the incumbent — no
// label, no series, no derivation. So "is a cheaper model acceptable?" was being put to a
// moderation-quality owner with no data attached, which is why it stayed parked. This module
// produces that data and nothing else.
//
// 🔴 IT IS A MEASUREMENT, NOT A MIGRATION, AND IT MUST NEVER BECOME ONE BY ACCIDENT. The verdict of
// record is ALWAYS the incumbent model's. Nothing here is awaited, nothing here is returned to a
// caller, and no code path reads a shadow result back. Switching the gate to a different model is a
// moderation-policy decision and must be its own change with its own review.
//
// 🔴 NO PROMPT IS EVER STORED OR LOGGED. The prompt is passed to the candidate classifier in the
// request body — exactly as the live call already does, to the same vendor — and is then dropped.
// Only a bounded outcome label reaches the metric. This is deliberate: the surrounding moderation
// path is built not to retain prompts (the verdict cache stores only a digest), and a probe that
// needed a prompt corpus would mean extracting real user prompts to compare offline. This design
// exists precisely so that is unnecessary.
import { env } from '~/env/server';
import { deriveModerationVerdict } from '~/server/integrations/moderation-verdict-policy';
import {
  clampExternalModerationSource,
  recordExternalModerationShadow,
  type ExternalModerationSource,
  type ModerationShadowOutcome,
} from '~/server/prom/external-moderation.metrics';

/** The verdict shape both models are reduced to before comparison. */
export type ShadowComparableVerdict = { flagged: boolean };

/**
 * Decide the comparison outcome from the two verdicts.
 *
 * 🔴 THE TWO DISAGREEMENT DIRECTIONS ARE NOT INTERCHANGEABLE AND MUST NOT SHARE A LABEL. A bare
 * `match`/`diverged` split — which is what the sibling `form_graph_shadow_parse_total` uses, and
 * which is right for THAT cutover because a parse is either correct or it is not — would be
 * actively misleading here, because the two directions have opposite consequences:
 *
 * - `candidate_permissive` — the incumbent flagged and the candidate did NOT. The candidate would
 *   have let this prompt through a FAIL-CLOSED gate. This is the direction that carries
 *   trust-and-safety risk, and it is the number the decision actually turns on.
 * - `candidate_strict` — the candidate flagged and the incumbent did not. A false positive: a user
 *   is blocked who is not blocked today. Real cost, but a UX cost, not a safety one.
 *
 * Averaged into one "divergence rate" those cancel, and a candidate that is 2% more permissive and
 * 2% stricter reads as identical to one that agrees perfectly. Split, the owner can weigh the two
 * against each other, which is the whole judgement they are being asked to make.
 */
export function classifyShadowOutcome(
  live: ShadowComparableVerdict,
  candidate: ShadowComparableVerdict
): ModerationShadowOutcome {
  // Coerced HERE rather than in `deriveModerationVerdict`. `flagged` originates from an untyped
  // `res.json()`, so a vendor sending a truthy non-boolean would make a bare `===` report a
  // disagreement between two verdicts that both mean "flagged". Normalising in the live derivation
  // instead would be a behaviour change on the gate itself; normalising in the comparison cannot be.
  const liveFlagged = Boolean(live.flagged);
  const candidateFlagged = Boolean(candidate.flagged);
  if (liveFlagged === candidateFlagged) return 'match';
  return liveFlagged ? 'candidate_permissive' : 'candidate_strict';
}

/**
 * Is the probe armed? BOTH inputs are required, neither defaults on.
 *
 * `EXTERNAL_MODERATION_SHADOW_MODEL` names the candidate; `EXTERNAL_MODERATION_SHADOW_SAMPLE` is the
 * share of calls to duplicate, in [0,1]. Two inputs rather than one because they answer different
 * questions — WHICH model, and HOW MUCH it costs to ask — and because it mirrors the two-input
 * arming the verdict cache already uses on this same path, so an operator meets one convention.
 *
 * 🔴 THE SAMPLE RATE IS THE SPEND CONTROL, AND IT IS THE REASON THIS IS NOT SIMPLY A BOOLEAN. Every
 * sampled call is a SECOND billable classifier request against the production credential. At 1.0
 * this doubles the moderation bill for as long as it is armed. Arm it low, read the rate, disarm.
 *
 * ⚠️ NO ALLOWLIST ON THE MODEL NAME, and that is a considered choice rather than an oversight. The
 * sibling cache probe's namespace IS a closed allowlist, because there a wrong-but-plausible value
 * silently opens a second keyspace and measures a FICTION that looks like a real reading. This field
 * has no such failure mode: a model name the vendor does not recognise makes every sampled request
 * fail, which surfaces as ~100% `error` and zero `match` — a shape no reader can mistake for a
 * result. The sample rate bounds the wasted spend meanwhile. Guarding it would be ceremony.
 */
function shadowConfig(): { model: string; sample: number } | null {
  const model = env.EXTERNAL_MODERATION_SHADOW_MODEL?.trim();
  const sample = env.EXTERNAL_MODERATION_SHADOW_SAMPLE;
  if (!model) return null;
  if (!(sample > 0)) return null; // also excludes NaN, which `> 0` rejects and `<= 0` would not
  return { model, sample };
}

/**
 * Compare the incumbent's verdict against a candidate model's, on a sampled share of calls.
 *
 * 🔴 TOTAL AND FIRE-AND-FORGET. This function returns `void`, never throws, and is never awaited.
 * It is called AFTER the live verdict is known and after that call's own outcome has been recorded,
 * so it cannot alter a verdict, cannot add latency to the generation submit, and cannot perturb the
 * duration histogram that measures what a classifier call costs. A shadow failure is recorded as
 * `error` and is otherwise invisible.
 *
 * @param source        the population label, clamped to the closed set.
 * @param preparedPrompt the string the LIVE call sent — post-`removeFalsePositiveTriggers`. Passing
 *                       the raw prompt instead would compare the two models on different inputs and
 *                       attribute the substitution's effect to the model.
 * @param live          the verdict the incumbent model produced for this same string.
 */
export function probeShadowModel(
  source: unknown,
  preparedPrompt: string,
  live: ShadowComparableVerdict
): void {
  const metricSource: ExternalModerationSource = clampExternalModerationSource(source);
  try {
    const config = shadowConfig();
    if (!config) return;
    if (Math.random() >= config.sample) return;

    const endpoint = env.EXTERNAL_MODERATION_ENDPOINT;
    const token = env.EXTERNAL_MODERATION_TOKEN;
    // The live call cannot have happened without these, so this is belt-and-braces rather than a
    // reachable branch — but it keeps the module independently safe if it is ever called earlier.
    if (!endpoint || !token) return;

    void runShadowComparison(metricSource, endpoint, token, config.model, preparedPrompt, live);
  } catch {
    // Arming/sampling must never be able to break a generation submit. A throw here would propagate
    // synchronously into `moderatePrompt`'s try, whose catch fails the call SOFT — i.e. a bug in a
    // dark measurement would silently drop the external moderation layer for that request.
    recordExternalModerationShadow(metricSource, 'error');
  }
}

async function runShadowComparison(
  metricSource: ExternalModerationSource,
  endpoint: string,
  token: string,
  model: string,
  preparedPrompt: string,
  live: ShadowComparableVerdict
): Promise<void> {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ input: preparedPrompt, model }),
      // Same deadline as the live call. A shadow request that outlives the request it shadows would
      // hold a socket for a result nobody is waiting for.
      signal: AbortSignal.timeout(env.EXTERNAL_MODERATION_TIMEOUT_MS),
    });
    if (!res.ok) {
      recordExternalModerationShadow(metricSource, 'error');
      return;
    }
    const { results } = await res.json();
    if (!results?.[0]) {
      recordExternalModerationShadow(metricSource, 'error');
      return;
    }
    // 🔴 The candidate's raw response is reduced by the SAME policy derivation the live verdict went
    // through — the shared module, not a reimplementation. Reimplementing it here would compare a
    // policy-applied verdict against a raw one and report the POLICY's effect as the MODEL's
    // disagreement.
    const candidate = deriveModerationVerdict(
      results[0],
      env.EXTERNAL_MODERATION_THRESHOLD,
      env.EXTERNAL_MODERATION_CATEGORIES
    );
    recordExternalModerationShadow(metricSource, classifyShadowOutcome(live, candidate));
  } catch {
    recordExternalModerationShadow(metricSource, 'error');
  }
}
