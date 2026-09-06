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
//     path from a cache problem to a weaker verdict. The added latency is bounded by
//     `withSysReadDeadline` (`REDIS_SYS_READ_TIMEOUT_MS`, default 2000 ms) — NOT by the Redis
//     client, which has no socket timeout, and NOT by the try/catch, which cannot see a hang.
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
 * The deployment this cache may write under, or `null` when it is not armed.
 *
 * 🔴 WITHOUT THIS SEGMENT THE CACHE IS CROSS-DEPLOYMENT, AND THAT IS A MODERATION BUG, NOT A
 * TIDINESS ONE. Several civitai-web deployments share ONE sysRedis, and sys keys — unlike cache
 * keys — carry no environment segment. Worse, the PR-preview Tekton task copies civitai-next's
 * `civitai-cfg` ConfigMap WHOLESALE into every `civitai-pr-<N>` namespace, overriding only an
 * explicit key list, so a NEW variable like the TTL below is inherited by every open PR's preview,
 * and ~10 of those share one `civitai-pr-sysredis`.
 *
 * The policy digest cannot close this. It covers the model, threshold and category map — but not
 * `EXTERNAL_MODERATION_ENDPOINT`, not the token, and above all not the CODE in `moderation.ts` that
 * derives `flagged` from the scores. A preview branch that changes that derivation, or points the
 * endpoint at a stub, writes `{"f":false,"c":[]}` under a policy digest IDENTICAL to production's,
 * and any other armed deployment reads it as an authoritative "not flagged".
 *
 * 🔴 SO ARMING AND NAMESPACING ARE ONE ACTION — the rule the dark probe already established for a
 * WRITE-ONLY instrument whose worst outcome was a biased number. This one SERVES VERDICTS ON A
 * MODERATION GATE, so it inherits that rule a fortiori.
 *
 * ⚠️ THIS IS A SECOND REQUIRED INPUT, AND AN EARLIER REVISION OF THIS MODULE ARGUED AGAINST ONE
 * ("a second on/off input is a second thing that can disagree with the first"). That argument was
 * wrong here: these are not two on/off switches. One names WHERE the entries live and one says HOW
 * LONG they live; neither can be inferred from the other, and both are necessary by construction.
 *
 * A CLOSED ALLOWLIST, not a charset plus a denylist — the probe's audit enumerated the survivors of
 * the charset approach (`y`, `n`, `none`, `null`, `disable`, `2`), and `y`/`n` are exactly how an
 * operator spells "off", which would ARM the cache under a namespace called `n`.
 *
 * Duplicated from the probe rather than imported: the probe is a temporary instrument scheduled for
 * removal, and a cache on a moderation gate must not acquire a dependency that is expected to be
 * deleted.
 */
export const CACHE_NAMESPACES: readonly string[] = Object.freeze(['prod']);

let warnedNamespace: string | null = null;

function cacheNamespace(): string | null {
  const raw = env.EXTERNAL_MODERATION_CACHE_NAMESPACE?.trim() ?? '';
  if (raw === '') return null;
  if (CACHE_NAMESPACES.includes(raw)) return raw;
  if (warnedNamespace !== raw) {
    warnedNamespace = raw;
    console.error(
      `[moderation-verdict-cache] EXTERNAL_MODERATION_CACHE_NAMESPACE=${JSON.stringify(raw)} is ` +
        `not a known deployment (${CACHE_NAMESPACES.join(', ')}). The cache is DISABLED. This is ` +
        `the safe direction: an unrecognised deployment must never share a verdict keyspace.`
    );
  }
  return null;
}

/**
 * Seconds to hold a verdict, or 0 when the cache is OFF.
 *
 * 🔴 THE TTL IS THE ARMING SWITCH — there is no separate boolean, for the reason the probe's
 * namespace allowlist exists: a second on/off input is a second thing that can disagree with the
 * first. Absent or 0 means the cache is inert and emits no series at all, which is the state every
 * deployment starts in. A non-numeric value is rejected by the env schema, not silently coerced.
 *
 * ⚠️ IT IS NOT A HOT KILL SWITCH, AND AN EARLIER REVISION OF THIS COMMENT CLAIMED IT WAS. It said
 * the per-call read meant "a config change takes effect on the next request instead of the next
 * deploy". That is FALSE: `src/env/server.ts` runs `serverSchema.safeParse(process.env)` ONCE at
 * import and exports `env` as a plain object spread, so reading it per call re-reads a frozen
 * snapshot for the life of the process. DISABLING THIS REQUIRES A ROLLOUT, exactly as much as a
 * module-level `const` would.
 *
 * 🔴 The suite could not have caught that, and still cannot: it mocks `~/env/server` with a MUTABLE
 * hoisted object and flips it mid-test, so the fixture makes the false claim true. The claim is
 * corrected here rather than pinned by a test, because pinning it would need a test that imports
 * the real env module.
 *
 * The per-call read is kept anyway — it costs nothing and keeps this function honest about where
 * the value comes from — but do not read it as a rollout-free lever.
 */
function ttlSeconds(): number {
  const raw = env.EXTERNAL_MODERATION_CACHE_TTL_SECONDS;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export function moderationCacheEnabled(): boolean {
  return cacheNamespace() !== null && ttlSeconds() > 0;
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
  namespace: string,
  policy: string,
  digest: string
): `${P}:${string}` {
  return `${prefix}:${namespace}:${policy}:${digest}`;
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
  const namespace = cacheNamespace();
  if (namespace === null || ttlSeconds() <= 0) return null;
  const metricSource = clampExternalModerationSource(source);
  try {
    const { sysRedis, REDIS_SYS_KEYS, withSysReadDeadline } = await import('~/server/redis/client');
    const key = buildVerdictKey(
      REDIS_SYS_KEYS.GENERATION.MODERATION_VERDICT,
      namespace,
      policy,
      promptDigest(preparedPrompt)
    );
    // 🔴 DEADLINE-WRAPPED, AND THE UNWRAPPED VERSION WAS A DEPLOY-BLOCKER. The sys client carries
    // NO socketTimeout (`REDIS_SYS_SOCKET_TIMEOUT_MS` defaults to 0, to avoid a reconnect-storm
    // wedge on the single-replica backend), so on a SILENT half-open a written command parks in
    // node-redis's reply queue until OS TCP keepalive errors the socket — Linux default ~11 MINUTES
    // — on every authenticated request. The `try/catch` below catches REJECTIONS, not HANGS.
    //
    // This read is awaited on the generation submission path, so unwrapped it would park the whole
    // tRPC handler off-CPU. That is the exact failure `moderation.ts` added `AbortSignal.timeout`
    // for after an observed ~194 s api-primary tail — putting an UNBOUNDED wait in front of that
    // bounded call would have reinstated it. `promptAuditing.ts`, the immediate caller, wraps all
    // four of its own sys reads the same way; this is the convention, not a precaution.
    const raw = await withSysReadDeadline(sysRedis.get(key));
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
  const namespace = cacheNamespace();
  const ttl = ttlSeconds();
  if (namespace === null || ttl <= 0) return;
  void (async () => {
    try {
      const { sysRedis, REDIS_SYS_KEYS } = await import('~/server/redis/client');
      const key = buildVerdictKey(
        REDIS_SYS_KEYS.GENERATION.MODERATION_VERDICT,
        namespace,
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
