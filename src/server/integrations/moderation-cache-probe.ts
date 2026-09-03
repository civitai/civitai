// DARK PROBE: would caching external prompt-moderation verdicts actually pay?
//
// WHY this exists. `extModeration.moderatePrompt` is an outbound HTTPS call that runs inline and
// serially on the generation submission path, and it is expensive in WALL TIME: measured in
// production it is ~200 ms per call at p50 ~188 ms, and it accounts for roughly 78-88% of the
// app-side (non-orchestrator-submit) time of `orchestrator.generateFromGraph`.
//
// Three ways to make that cheaper were tested against production measurements and ALL THREE ARE
// DEAD, which is what makes this probe the remaining question rather than one option among many:
//   1. Tune the tail / the abort deadline — the distribution is a FLOOR, not a tail. Zero calls
//      land under 50 ms and 0.46% under 100 ms, so clamping the slow 1.18% is worth single-digit
//      milliseconds of the mean.
//   2. Reuse the connection — the call does pay a fresh TCP+TLS handshake on most invocations
//      (call spacing per process far exceeds undici's 4 s default keep-alive, and nothing in this
//      app configures a dispatcher), but the classifier answers from a nearby edge, so the whole
//      handshake measures ~7-24 ms. Not the lever it looks like.
//   3. Overlap it with the workflow submit — impossible by construction. The audit is a
//      FAIL-CLOSED gate: a flagged prompt throws and must never reach `submitWorkflow`.
// What is left is the classifier's own inference time, and the only way to avoid paying it is to
// NOT MAKE THE CALL. That is worth building only if prompts actually repeat — and nobody knows
// whether they do. This module measures exactly that, and nothing else.
//
// 🔴 IT IS A MEASUREMENT, NOT A CACHE, AND IT MUST NEVER BECOME ONE BY ACCIDENT. No caller reads a
// verdict back from here; `moderatePrompt` issues its request every single time regardless of what
// this reports. Changing that is a moderation-policy decision (a stale verdict is a trust-and-safety
// question, not a performance one) and must be its own change with its own review.
import { createHash } from 'node:crypto';

import { registerCounterWithLabels } from '@civitai/telemetry/client';
import { env } from '~/env/server';
import {
  clampExternalModerationSource,
  type ExternalModerationSource,
} from '~/server/prom/external-moderation.metrics';

/**
 * The windows the probe simulates, as (label, seconds) pairs.
 *
 * 🔴 TWO WINDOWS, NOT ONE, AND THAT IS THE POINT. A single hit rate is one number with no shape:
 * it cannot distinguish "users re-roll the same prompt within minutes" (a tiny TTL captures nearly
 * all of the value, and a small cache is enough) from "the same prompts recur all day across
 * different users" (the value keeps climbing with TTL, and the cache has to be big). Those imply
 * completely different builds. Measuring at a boundary AND a middle is what makes the answer a
 * curve instead of an anecdote.
 *
 * `5m` and `1h` are 12x apart deliberately — close enough that both are cheap, far enough that a
 * flat reading between them is real evidence of saturation rather than measurement noise.
 */
const PROBE_WINDOWS = [
  { label: '5m', seconds: 300 },
  { label: '1h', seconds: 3600 },
] as const;

type ProbeWindowLabel = (typeof PROBE_WINDOWS)[number]['label'];

/**
 * `miss` = this exact prepared prompt had not been seen inside the window (a real cache would have
 * called the classifier). `hit` = it had (a real cache would have skipped the call). `error` = the
 * probe itself failed — Redis unreachable, a command deadline, anything.
 *
 * 🔴 `error` IS A SEPARATE RESULT SO THE HIT RATE CANNOT SILENTLY DEFLATE. Divide by `hit + miss`,
 * NEVER by the total across all three: a Redis outage would otherwise read as "prompts stopped
 * repeating", which is the reassuring direction and therefore the dangerous one.
 */
type ProbeResult = 'hit' | 'miss' | 'error';

const probeCounter = registerCounterWithLabels({
  name: 'external_moderation_cache_probe_total',
  help:
    'DARK PROBE (measurement only, changes no behaviour): counts whether the exact string sent to ' +
    'the external prompt classifier had already been seen inside a window, to size whether caching ' +
    'moderation verdicts would pay. Labeled by source (same population split as ' +
    'external_moderation_duration_seconds), window (5m|1h) and result (hit|miss|error). A hit means ' +
    'a real cache with that TTL WOULD have skipped the call — the classifier was still called. ' +
    'COMPUTE THE HIT RATE AS hit/(hit+miss), never over the total: error is Redis failing, and ' +
    'folding it in makes an outage look like "prompts stopped repeating". 🔴 IGNORE THE FIRST FULL ' +
    'WINDOW AFTER ARMING — the probe keyspace starts empty, so every observation is necessarily a ' +
    'miss until it has been running longer than the window it is measuring, and a hit rate read too ' +
    'early is biased toward zero by construction. Gated by EXTERNAL_MODERATION_CACHE_PROBE; with the ' +
    'flag off there are no series at all, which is what makes the arming instant readable.',
  labelNames: ['source', 'window', 'result'] as const,
});

function record(
  source: ExternalModerationSource,
  window: ProbeWindowLabel,
  result: ProbeResult
): void {
  try {
    probeCounter.inc({ source, window, result });
  } catch {
    // Observability must never break the moderation path. Swallow any prom-client error.
  }
}

/**
 * Hash of the exact string handed to the classifier.
 *
 * Truncated to 32 hex chars (128 bits) because the only operation performed on it is equality
 * inside one bounded window — collisions at 128 bits are not a practical concern at these volumes,
 * and the shorter key keeps the probe keyspace small.
 *
 * 🔴 THE PROMPT ITSELF IS NEVER STORED, LOGGED OR LABELLED. Only this digest reaches Redis, and
 * nothing user-controlled reaches a metric label — a prompt on a label would be an unbounded
 * cardinality incident on a hot path, on top of being user content in an observability system.
 */
function digestPrompt(preparedPrompt: string): string {
  return createHash('sha256').update(preparedPrompt).digest('hex').slice(0, 32);
}

/**
 * Fire-and-forget. Records, for each window, whether `preparedPrompt` had been seen before.
 *
 * 🔴 DELIBERATELY NOT AWAITED BY THE CALLER, AND THAT IS LOAD-BEARING TWICE OVER. First, this runs
 * on the generation submission path: awaiting a Redis round trip here would add latency to the very
 * request whose latency is under investigation, so the instrument would perturb its own subject.
 * Second, it makes the probe unable to fail the generation — there is no path from a Redis problem
 * to a user-visible error, because nothing downstream is waiting on this promise.
 *
 * The Redis client is imported LAZILY, inside the async body. `moderation.ts` is imported by a cron
 * job and keeps a deliberately light import graph; a static import here would pull the whole Redis
 * client into it for a feature that is off by default.
 */
export function probeModerationCacheRepeat(
  source: ExternalModerationSource,
  preparedPrompt: string
): void {
  if (!env.EXTERNAL_MODERATION_CACHE_PROBE) return;
  // `void` + a terminal catch: an unhandled rejection here would be a process-level event raised by
  // an instrument that is explicitly not allowed to affect anything.
  void runProbe(clampExternalModerationSource(source), preparedPrompt).catch(() => {
    // `runProbe` already records `error` per window; this only guards a throw before that point
    // (e.g. the dynamic import itself failing), which has no window to attribute.
  });
}

async function runProbe(source: ExternalModerationSource, preparedPrompt: string): Promise<void> {
  const digest = digestPrompt(preparedPrompt);
  const { sysRedis, REDIS_SYS_KEYS } = await import('~/server/redis/client');

  await Promise.all(
    PROBE_WINDOWS.map(async ({ label, seconds }) => {
      try {
        // SET NX EX is the whole measurement, in one atomic round trip: it returns a truthy reply
        // when the key did NOT exist (a miss, and the key is now claimed for `seconds`) and null
        // when it did (a hit). Doing this as GET-then-SET would race two concurrent submissions of
        // the same prompt into two misses and undercount exactly the population being measured.
        //
        // 🔴 The TTL is FIXED FROM FIRST WRITE, not sliding — NX means a hit does not extend it. So
        // this simulates the CONSERVATIVE cache design; one that refreshed its TTL on every hit
        // would score at least as high. Read the result as a floor on the achievable hit rate.
        const key =
          `${REDIS_SYS_KEYS.GENERATION.MODERATION_CACHE_PROBE}:${label}:${digest}` as const;
        const claimed = await sysRedis.set(key, '1', { NX: true, EX: seconds });
        record(source, label, claimed ? 'miss' : 'hit');
      } catch {
        record(source, label, 'error');
      }
    })
  );
}
