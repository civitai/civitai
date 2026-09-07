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
// ⚠️ "CANNOT ALTER A VERDICT" IS A STATEMENT ABOUT THIS CODE, NOT ABOUT THE VENDOR. There is one
// indirect path, named here rather than left for someone to rediscover: the probe DOUBLES the
// request rate against a shared per-organisation quota. Measured on production 2026-09-07 the live
// call runs ~4.3 req/s, so `SAMPLE=1.0` adds ~4.3 req/s (~371k requests/day). If that were ever
// enough to provoke vendor 429s they would land on the LIVE calls too — and the live call is
// FAIL-SOFT, so a rate-limited moderation request proceeds as `flagged:false` and silently drops
// the external layer. At the measured volume the margin is wide, so this is a mechanism note and
// not a prediction. It is still the reason to arm at a LOW sample rate rather than at 1.0.
//
// 🔴 THERE IS NO IN-PROCESS KILL SWITCH. `env` is parsed once at process start, so disarming needs a
// POD ROLLOUT — editing the ConfigMap alone changes nothing on already-running pods. Budget for
// that before arming, not during an incident. (Inherited from the sibling probes on this path,
// not introduced here.)
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
 * Can the candidate's response even be REDUCED by the incumbent's policy?
 *
 * 🔴 THIS IS THE DIFFERENCE BETWEEN A MEASUREMENT AND A PLAUSIBLE FICTION, and without it the
 * probe's headline number is unrelated to the candidate's quality. When
 * `EXTERNAL_MODERATION_CATEGORIES` is configured, `deriveModerationVerdict` computes
 * `flagged = any MAPPED category the classifier marked true` — and production configures a SINGLE
 * key (`sexual/minors`). A candidate model that classifies the same content under a different
 * category name returns a response with no such key, so `Boolean(undefined)` makes its verdict
 * `false` on EVERY call. It then reads as `candidate_permissive` on every prompt the incumbent
 * flagged, at zero errors — i.e. a candidate in PERFECT agreement and one that is completely blind
 * produce the IDENTICAL, entirely reasonable-looking metric, on a decision about a fail-closed gate.
 *
 * ⚠️ Threshold mode needs no such check and deliberately returns true: there the verdict is the
 * classifier's OWN `flagged` boolean, which is model-native and therefore comparable across
 * vocabularies. The hazard is specific to category-map mode.
 *
 * `hasOwnProperty` rather than `in`, because `in` walks the prototype chain: with a map key of
 * `toString` or `constructor` — operator-controlled, so not untrusted, but free to get right — `in`
 * would report the vocabulary covered on a response that carries nothing of the sort. Same failure
 * shape this codebase has already been bitten by elsewhere.
 */
export function candidateVocabularyCovers(
  result: { categories?: unknown },
  categoryMap: Record<string, string> | undefined
): boolean {
  if (!categoryMap) return true;
  const categories = result?.categories;
  if (!categories || typeof categories !== 'object') return false;
  return Object.keys(categoryMap).every((key) =>
    Object.prototype.hasOwnProperty.call(categories, key)
  );
}

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
 * ⚠️ NO ALLOWLIST ON THE MODEL NAME. A name the vendor does not recognise makes every sampled
 * request fail, surfacing as ~100% `error` and zero `match` — a shape no reader mistakes for a
 * result — and the sample rate bounds the wasted spend meanwhile.
 *
 * 🔴 THAT REASONING IS ABOUT AN UNRECOGNISED NAME AND DOES NOT EXTEND TO A RECOGNISED ONE. An
 * earlier revision of this comment stopped at "guarding it would be ceremony", which primed the
 * reader to treat a zero `error` rate as proof the candidate was working. It is not: a perfectly
 * valid model that answers in a different CATEGORY VOCABULARY produces 200s, zero errors, and a
 * completely fictional agreement rate. That hole is closed by `candidateVocabularyCovers` and the
 * `incomparable` outcome above, NOT by anything about the model name — read them together.
 *
 * 🔴 AND IT REFUSES TO ARM IN A PR PREVIEW, which is a CONFIG-INHERITANCE guard, not a model guard.
 * The preview deploy task copies `civitai-cfg` out of `civitai-next` and rewrites an enumerated key
 * list that cannot include fields that did not exist when it was written — so an operator doing the
 * cautious thing and arming on STAGING first would silently arm every open PR preview at its next
 * deploy, each issuing a second billable request per moderation call against the production
 * credential, unattributed and with nobody reading preview metrics. `IS_PREVIEW` is the same signal
 * `~/env/database-target` falls back to. Deliberately NOT `isNonProductionDatabase()`, which is
 * wider: that would also refuse a DELIBERATE staging arm, which is a legitimate operator choice and
 * the exact workflow this guard is meant to keep safe rather than block.
 */
function shadowConfig(): { model: string; sample: number } | null {
  if (process.env.IS_PREVIEW === 'true') return null;
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
  // ⚠️ This clamp NARROWS THE TYPE at the boundary (`unknown` in, closed set out) and is
  // BEHAVIOURALLY REDUNDANT: `recordExternalModerationShadow` clamps again, so replacing this call
  // with a bare cast leaves the whole suite green — no mutant kills it on its own, and the
  // "clamps an out-of-set source" test below is satisfied by the metrics-layer clamp, not by this
  // line. Stated rather than quietly counted as covered. It stays because the parameter is
  // `unknown` and something must narrow it, not because it is the guard that holds the property.
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
    // 🔴 Vocabulary gate BEFORE the comparison, never after. Reducing an unreadable response would
    // silently produce `flagged:false` and book it as a real disagreement. See the function's own
    // header for why that specific wrong answer is the dangerous one.
    if (!candidateVocabularyCovers(results[0], env.EXTERNAL_MODERATION_CATEGORIES)) {
      recordExternalModerationShadow(metricSource, 'incomparable');
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
