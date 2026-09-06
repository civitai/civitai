// A read-through cache for external prompt-moderation verdicts.
//
// WHY. `extModeration.moderatePrompt` is an outbound HTTPS call that runs inline and serially on the
// generation submission path, costing ~205 ms at p50 ~188 ms and accounting for 78-88% of the
// app-side time of `orchestrator.generateFromGraph`. Three ways to make the CALL cheaper were tested
// against production and all three are dead: the latency distribution is a FLOOR not a tail (zero
// calls under 50 ms), connection reuse is worth ~7-24 ms because the classifier answers from a
// nearby edge, and the audit cannot be overlapped with the workflow submit because a flagged prompt
// must never reach `submitWorkflow`. What is left is to NOT MAKE THE CALL.
//
// The dark probe that preceded this module measured whether that is worth doing: over 224,989
// observations spanning the quietest overnight hours through the weekly peak, 34.3% of prepared
// prompts had been seen before inside 5 minutes, and the rate is LOAD-INVARIANT (+1.63 points across
// a ~33% swing in call volume). At ~205 ms a call that is ~70 ms per invocation, roughly 7x the best
// infra lever. The probe is retired; this replaces it.
//
// 🔴 WHAT THIS CHANGES ABOUT MODERATION, STATED PLAINLY. A cached verdict is a STALE verdict: within
// the TTL, an identical prompt gets the previous answer without consulting the classifier. That is a
// trust-and-safety trade, not a performance detail, and it was accepted deliberately rather than
// arrived at. Two things bound it:
//
//   1. The TTL is short and operator-set, and the cache is OFF unless a TTL is configured.
//   2. 🔴 THE KEY CARRIES A DIGEST OF THE POLICY THAT PRODUCED THE VERDICT — see `policyDigest`.
//      A change to the model, the score threshold or the category map changes the key, so every
//      previously-cached verdict becomes unreachable AT ONCE, without a flush and without anyone
//      remembering to bump anything. This is the mechanical half of the staleness answer: the
//      remaining exposure is a policy change that happens OUTSIDE this app (the classifier's own
//      model being retrained behind a stable name), which the TTL bounds and nothing here can see.
//
// 🔴 WHAT IS NOT CACHED, AND WHY EACH OMISSION IS LOAD-BEARING:
//   * FAILURES. Only an `ok` outcome is stored. `moderatePrompt` is fail-SOFT on error — the caller
//     catches and proceeds with `flagged:false`, with the local regex audit still gating — so
//     caching a failure would convert one transient gateway error into TTL-long silent
//     under-moderation of that exact prompt. A failure must cost a retry, every time.
//   * CACHE ERRORS. A Redis failure resolves to a MISS and the classifier is called. There is no
//     path from a cache problem to a weaker verdict; the worst case is the latency we already pay
//     today.
import { createHash } from 'node:crypto';

import { registerCounterWithLabels } from '@civitai/telemetry/client';
import { env } from '~/env/server';
import {
  clampExternalModerationSource,
  type ExternalModerationSource,
} from '~/server/prom/external-moderation.metrics';

/** The verdict shape `moderatePrompt` returns and this module round-trips. */
export interface ModerationVerdict {
  flagged: boolean;
  categories: string[];
}

/**
 * `hit` = a stored verdict was returned and the classifier was NOT called. `miss` = nothing stored,
 * the classifier was called. `error` = the cache itself failed (Redis unreachable, malformed stored
 * value); the classifier was called, so an `error` costs latency but never correctness.
 *
 * 🔴 SEPARATE FROM THE DURATION HISTOGRAM, DELIBERATELY. A cache hit is NOT observed on
 * `civitai_app_external_moderation_duration_seconds`. If hits were recorded there as ~0 ms samples
 * they would drag the p50 down and destroy the one instrument that measures what a classifier call
 * actually costs — the same instrument that has to grade any future decision about the model. So
 * after this ships, that histogram's `_count` is CLASSIFIER CALLS, not moderation checks; the
 * check count is `hit + miss` here. Anyone comparing a before/after on that histogram must know
 * this, because the denominator changed meaning on the day the cache armed.
 */
type CacheResult = 'hit' | 'miss' | 'error';

const cacheCounter = registerCounterWithLabels({
  name: 'external_moderation_cache_total',
  help:
    'Read-through cache for external prompt-moderation verdicts. Labeled by source (same population ' +
    'split as external_moderation_duration_seconds) and result (hit|miss|error). A hit means the ' +
    'classifier was NOT called. COMPUTE THE HIT RATE AS sum(rate(...{result="hit"}[..])) / ' +
    'sum(rate(...{result=~"hit|miss"}[..])) — dividing over the TOTAL folds in `error`, so a Redis ' +
    'outage would read as "prompts stopped repeating", the reassuring direction and therefore the ' +
    'dangerous one. 🔴 A hit is NOT observed on external_moderation_duration_seconds, so once this ' +
    'is armed that histogram counts CLASSIFIER CALLS and this counter counts moderation CHECKS; ' +
    'the two diverge by exactly the hit count. Unarmed (no EXTERNAL_MODERATION_CACHE_TTL_SECONDS) ' +
    'there are no series at all, which is what makes the arming instant readable. The dark probe ' +
    'this replaces measured 34.3% repeats at a 5m window over 224,989 observations; expect a hit ' +
    'rate at or BELOW that, because the probe claimed its slot when a request STARTED whereas this ' +
    'cache cannot store a verdict until the classifier answers ~200 ms later.',
  labelNames: ['source', 'result'] as const,
});

function record(source: ExternalModerationSource, result: CacheResult): void {
  try {
    cacheCounter.inc({ source, result });
  } catch {
    // Observability must never break the moderation path.
  }
}

/**
 * Seconds to hold a verdict, or 0 when the cache is OFF.
 *
 * 🔴 THE TTL IS THE ARMING SWITCH — there is no separate boolean, for the reason the probe's
 * namespace allowlist exists: a second on/off input is a second thing that can disagree with the
 * first. Absent or 0 means the cache is inert and emits no series at all, which is the state every
 * deployment starts in. A non-numeric value is rejected by the env schema, not silently coerced.
 *
 * The value is read per call rather than captured at module load so a config change takes effect on
 * the next request instead of the next deploy — this is the kill switch, and a kill switch that
 * needs a rollout is not one.
 */
function ttlSeconds(): number {
  const raw = env.EXTERNAL_MODERATION_CACHE_TTL_SECONDS;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export function moderationCacheEnabled(): boolean {
  return ttlSeconds() > 0;
}

/**
 * A digest of everything OTHER than the prompt that determines the verdict.
 *
 * 🔴 THIS IS THE STALENESS ANSWER, AND IT IS MECHANICAL RATHER THAN PROCEDURAL. `moderatePrompt`
 * does not return the classifier's raw response: it derives `flagged` and `categories` from the
 * scores using `EXTERNAL_MODERATION_THRESHOLD` and, when set, `EXTERNAL_MODERATION_CATEGORIES` —
 * and it asks a specific `model`. A cached verdict is therefore a function of FOUR inputs, not one.
 * Keying on the prompt alone would serve verdicts computed under a policy that no longer exists, and
 * the failure would be silent and indefinite: lower the threshold to catch more, and every prompt
 * already in the cache keeps its old lenient answer until its TTL expires.
 *
 * Folding the policy into the KEY makes a policy change invalidate the entire cache atomically, with
 * no flush step and nothing for an operator to remember. The old entries are simply unreachable and
 * age out on their own EX.
 *
 * ⚠️ WHAT IT CANNOT SEE: a change to the classifier BEHIND a stable model name. `omni-moderation-latest`
 * is a moving target by construction, so its retraining is invisible here and is bounded only by the
 * TTL. That is the residual exposure, and it is the reason the TTL should stay short.
 *
 * Sorted `JSON.stringify` of the category map, because object key ORDER is not part of the policy and
 * must not change the digest — otherwise an unrelated config reshuffle silently flushes the cache.
 */
export function policyDigest(
  model: string,
  threshold: number,
  categories: Record<string, string | undefined> | undefined
): string {
  const normalizedCategories = categories
    ? Object.keys(categories)
        .sort()
        .map((k) => [k, categories[k] ?? null] as const)
    : null;
  const material = JSON.stringify({ model, threshold, categories: normalizedCategories });
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/**
 * Hash of the exact string handed to the classifier.
 *
 * 🔴 THE PROMPT ITSELF IS NEVER STORED. Only this digest reaches Redis. Truncated to 32 hex chars
 * (128 bits) because the only operation performed on it is equality inside one bounded window.
 *
 * 🔴 A COLLISION HERE RETURNS ANOTHER PROMPT'S VERDICT, which is why this is 128 bits and not the
 * 64 that would comfortably fit the keyspace. At ~17k live keys the birthday probability is on the
 * order of 1e-30; the cost of the extra 16 characters is nothing.
 */
function promptDigest(preparedPrompt: string): string {
  return createHash('sha256').update(preparedPrompt).digest('hex').slice(0, 32);
}

/**
 * `<prefix>:<policyDigest>:<promptDigest>`.
 *
 * Exported as a pure function taking the policy digest as an ARGUMENT for the reason the probe's
 * `buildProbeKey` was extracted: with one live configuration, a mutant that hardcodes the policy
 * segment is indistinguishable from the real thing at runtime, so a test must be able to drive it
 * with two different policies without config being able to produce them.
 */
export function buildVerdictKey<P extends string>(
  prefix: P,
  policy: string,
  digest: string
): `${P}:${string}` {
  return `${prefix}:${policy}:${digest}`;
}

/**
 * Serialized form. Deliberately terse and versioned by SHAPE rather than a version field: a stored
 * value that does not parse to this exact shape is treated as a MISS, so a future change to the
 * serialization cannot serve a half-understood verdict — the worst case is one extra classifier call.
 */
function serialize(v: ModerationVerdict): string {
  return JSON.stringify({ f: v.flagged, c: v.categories });
}

function deserialize(raw: string): ModerationVerdict | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const { f, c } = parsed as { f?: unknown; c?: unknown };
    // 🔴 STRICT. `flagged` must be a real boolean and `categories` an array of strings. A truthy
    // coercion here is how a malformed entry becomes a permissive verdict: `f: 0` from some future
    // encoder would read as "not flagged" under `!!f`, and that is the direction that lets a
    // flagged prompt through.
    if (typeof f !== 'boolean') return null;
    if (!Array.isArray(c) || c.some((x) => typeof x !== 'string')) return null;
    return { flagged: f, categories: c as string[] };
  } catch {
    return null;
  }
}

/**
 * Look up a stored verdict. Returns `null` on miss, on cache error, and when the cache is off.
 *
 * Awaited, unlike the probe it replaces — this one is on the critical path BY DESIGN, because its
 * whole purpose is to answer before the classifier is called. The Redis round trip it costs is
 * single-digit milliseconds against the ~205 ms it avoids.
 */
export async function readCachedVerdict(
  source: ExternalModerationSource,
  preparedPrompt: string,
  policy: string
): Promise<ModerationVerdict | null> {
  if (!moderationCacheEnabled()) return null;
  const metricSource = clampExternalModerationSource(source);
  try {
    const { sysRedis, REDIS_SYS_KEYS } = await import('~/server/redis/client');
    const key = buildVerdictKey(
      REDIS_SYS_KEYS.GENERATION.MODERATION_VERDICT,
      policy,
      promptDigest(preparedPrompt)
    );
    const raw = await sysRedis.get(key);
    if (raw == null) {
      record(metricSource, 'miss');
      return null;
    }
    const verdict = deserialize(raw);
    if (!verdict) {
      // Stored but unreadable. Counted as an ERROR rather than a miss: a miss is a normal, expected
      // outcome and would hide a serialization fault in the noise, whereas this should be visible.
      record(metricSource, 'error');
      return null;
    }
    record(metricSource, 'hit');
    return verdict;
  } catch {
    record(metricSource, 'error');
    return null;
  }
}

/**
 * Store a verdict. Fire-and-forget: nothing downstream waits on it, so a slow or broken Redis cannot
 * add latency to the request that produced the verdict, and cannot fail it.
 *
 * 🔴 CALL THIS ONLY ON AN `ok` OUTCOME. See the module header — caching a failure would turn one
 * transient error into TTL-long under-moderation of that prompt.
 */
export function writeCachedVerdict(
  preparedPrompt: string,
  policy: string,
  verdict: ModerationVerdict
): void {
  const ttl = ttlSeconds();
  if (ttl <= 0) return;
  void (async () => {
    try {
      const { sysRedis, REDIS_SYS_KEYS } = await import('~/server/redis/client');
      const key = buildVerdictKey(
        REDIS_SYS_KEYS.GENERATION.MODERATION_VERDICT,
        policy,
        promptDigest(preparedPrompt)
      );
      await sysRedis.set(key, serialize(verdict), { EX: ttl });
    } catch {
      // A write failure costs a future classifier call, nothing more. Not counted on the cache
      // counter: that counter's denominator is READ outcomes, and mixing a write failure into it
      // would make the hit rate uninterpretable.
    }
  })();
}
