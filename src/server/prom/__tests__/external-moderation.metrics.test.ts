/**
 * Contract tests for the external prompt-moderation metric family.
 *
 * These pin the three properties that make the family usable rather than merely present:
 *   1. the `source` label is CLOSED at runtime, not just in the type system. ⚠️ NOT because "an
 *      options object built by spread can carry any string" — that rationale was fiction and is
 *      retracted in full at `~/server/prom/external-moderation.metrics`: every production
 *      `auditPromptServer` call site builds an inline object literal, so excess-property checking
 *      applies to all of them. The real reason is that `moderatePrompt` is EXPORTED, so its second
 *      argument is reachable from callers `tsc` does not constrain — a value already widened to
 *      `string` (a cast, a `JSON.parse`), and the test tree, which `tsconfig.json` excludes. An
 *      unbounded label on a hot-path histogram is a cardinality incident, not a cosmetic bug;
 *   2. the BUCKET BOUNDARIES keep the deadline region readable — a finite boundary sits ABOVE the
 *      `EXTERNAL_MODERATION_TIMEOUT_MS` cap so a capped call is not swallowed by `+Inf`, and NO
 *      finite boundary sits ON the default cap, which would split the one `outcome=timeout`
 *      population across two buckets. ⚠️ NOT that a boundary tells a capped call apart from one that
 *      answered just under the cap — it cannot, and this file used to assert that it did; the
 *      separator is the `outcome` label. See the block comment above that describe;
 *   3. the not-configured short-circuit is counted SEPARATELY and never lands on the duration
 *      histogram, so it cannot drag the latency distribution toward zero.
 *
 * Read against the REAL prom-client registry (`@civitai/telemetry/client` is not stubbed by
 * src/__tests__/setup.ts, which only replaces `~/server/prom/client`), so every assertion below is
 * about what is actually recorded on the registry /api/metrics scrapes — not about whether we
 * called our own wrapper.
 */
import promClient from 'prom-client';
import { beforeEach, describe, expect, it } from 'vitest';

import { serverSchema } from '~/env/server-schema';
import {
  clampExternalModerationSource,
  isAbortDeadlineError,
  observeExternalModeration,
  recordExternalModerationSkipped,
} from '~/server/prom/external-moderation.metrics';

/**
 * The default `EXTERNAL_MODERATION_TIMEOUT_MS` deadline, in SECONDS, DERIVED from the schema that
 * defines it rather than written here as a literal.
 *
 * 🔴 WHY THIS IS NOT A `const CAP_SECONDS = 5`. The bucket guards below forbid a finite boundary on
 * the default deadline. Against a literal, that guard only ever forbids the number 5 — so if the
 * schema default became 3000, `src/env/__tests__/server-schema-moderation-timeout.test.ts` would go
 * red and be updated while this guard stayed green, and `3` IS a live boundary in
 * `EXTERNAL_MODERATION_BUCKETS`. The guard would then be passing while the exact split-timeout
 * defect it exists to prevent was reinstated. MEASURED: with the schema default temporarily set to
 * 3000, this derivation fails naming `[3]`. (The old literal `5` would stay green there by
 * inspection rather than by measurement — `EXTERNAL_MODERATION_BUCKETS` contains no `5`.)
 *
 * `.parse(undefined)` yields the `.catch(5000)` fallback — the same value production gets when the
 * env var is absent, which is what "the default deadline" means, and the same accessor that
 * schema test already uses.
 */
const CAP_SECONDS = serverSchema.shape.EXTERNAL_MODERATION_TIMEOUT_MS.parse(undefined) / 1000;

const HIST = 'civitai_app_external_moderation_duration_seconds';
const SKIPPED = 'civitai_app_external_moderation_skipped_total';

type Sample = { metricName?: string; labels: Record<string, string | number>; value: number };

async function samples(name: string): Promise<Sample[]> {
  const metric = promClient.register.getSingleMetric(name);
  if (!metric) throw new Error(`metric ${name} is not registered`);
  return (await metric.get()).values as Sample[];
}

async function histCount(source: string, outcome: string) {
  const vals = await samples(HIST);
  return (
    vals.find(
      (v) =>
        v.metricName === `${HIST}_count` &&
        v.labels.source === source &&
        v.labels.outcome === outcome
    )?.value ?? 0
  );
}

async function histSum(source: string, outcome: string) {
  const vals = await samples(HIST);
  return (
    vals.find(
      (v) =>
        v.metricName === `${HIST}_sum` && v.labels.source === source && v.labels.outcome === outcome
    )?.value ?? 0
  );
}

// NOTE: no `histBucket` helper here any more. Reading a single named boundary was only ever needed
// by the removed "a bucket edge separates a capped call from a sub-cap one" case; what survives
// reads the whole boundary LIST off the registry instead (see `finiteBoundaries` below). The
// per-boundary helper still lives in `moderation.instrumentation.test.ts`, which needs it to assert
// that a real capped call lands in a finite bucket rather than in `+Inf`.

async function skippedCount(source: string) {
  const vals = await samples(SKIPPED);
  return vals.find((v) => v.labels.source === source)?.value ?? 0;
}

beforeEach(() => {
  promClient.register.getSingleMetric(HIST)?.reset();
  promClient.register.getSingleMetric(SKIPPED)?.reset();
});

describe('clampExternalModerationSource', () => {
  it.each(['generate', 'preset', 'remixAudit', 'other'] as const)('keeps the member %s', (s) => {
    expect(clampExternalModerationSource(s)).toBe(s);
  });

  it.each([
    ['an unknown string', 'generateFromGraph'],
    ['a near-miss of a member', 'Generate'],
    ['an empty string', ''],
    // The shape a value widened to `string` produces: something from somewhere else entirely.
    ['a user-supplied-looking value', 'prompt: a cat'],
  ])('clamps %s to other', (_label, value) => {
    expect(clampExternalModerationSource(value)).toBe('other');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 3],
    ['an object', { source: 'generate' }],
    // Object.prototype keys are the classic fails-open key: `'toString' in {}` is true, so a
    // membership test written against a plain object rather than a Set would let this through.
    ['a prototype key', 'toString'],
    ['constructor', 'constructor'],
  ])('clamps %s to other', (_label, value) => {
    expect(clampExternalModerationSource(value)).toBe('other');
  });
});

describe('isAbortDeadlineError', () => {
  it('recognises a fired AbortSignal.timeout (TimeoutError)', () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    expect(isAbortDeadlineError(e)).toBe(true);
  });

  it('recognises a manual/composed abort (AbortError)', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    expect(isAbortDeadlineError(e)).toBe(true);
  });

  it('recognises a deadline nested under .cause, as undici reports it', () => {
    const inner = new Error('The operation was aborted due to timeout');
    inner.name = 'TimeoutError';
    const outer = new Error('fetch failed', { cause: inner });
    expect(isAbortDeadlineError(outer)).toBe(true);
  });

  it('does NOT classify an ordinary upstream failure as a deadline', () => {
    // The exact shape moderatePrompt throws on a non-2xx — this must be `error`, not `timeout`,
    // or the two failure modes the outcome label exists to separate get merged.
    expect(
      isAbortDeadlineError(new Error('External moderation failed: 503 Service Unavailable'))
    ).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'TimeoutError'],
  ])('returns false for %s rather than throwing', (_label, value) => {
    expect(isAbortDeadlineError(value)).toBe(false);
  });

  it('terminates on a self-referential cause chain', () => {
    const e: { name: string; cause?: unknown } = { name: 'Error' };
    e.cause = e;
    expect(isAbortDeadlineError(e)).toBe(false);
  });
});

describe('observeExternalModeration', () => {
  it('records one observation on the labelled series, carrying the duration', async () => {
    observeExternalModeration('generate', 'ok', 0.123);

    expect(await histCount('generate', 'ok')).toBe(1);
    // The VALUE, not only the count: the deliverable of this instrument is a duration number, so a
    // test that only counted calls would pass against an implementation recording zeros.
    expect(await histSum('generate', 'ok')).toBeCloseTo(0.123, 6);
    expect(await histCount('generate', 'error')).toBe(0);
    expect(await histCount('other', 'ok')).toBe(0);
  });

  it('clamps an out-of-vocabulary source at the recording site, not only at the call site', async () => {
    observeExternalModeration('nonsense' as never, 'ok', 0.2);

    expect(await histCount('other', 'ok')).toBe(1);
    expect(await histCount('nonsense', 'ok')).toBe(0);
  });

  it('never throws, so a metrics fault cannot fail a generation', () => {
    // A NaN duration is what prom-client rejects; the wrapper must swallow it.
    expect(() => observeExternalModeration('generate', 'ok', Number.NaN)).not.toThrow();
    expect(() => observeExternalModeration('generate', 'ok', 'x' as never)).not.toThrow();
  });
});

/**
 * ⚠️ WHAT THIS BLOCK DOES AND DOES NOT COVER — the description has now overstated it twice.
 *
 * These cases hand `observeExternalModeration` its numbers directly, so what they pin is the BUCKET
 * SET: that a finite boundary sits above the cap, that no finite boundary sits ON the default cap,
 * and that the sub-second population is resolved. They never run the code that PRODUCES a duration.
 *
 * 🔴 WHAT THIS BLOCK USED TO ASSERT AND NO LONGER DOES: that a bucket edge tells a capped call apart
 * from one that answered just under the cap. It cannot. `le` is inclusive, the deadline fires off a
 * libuv timer while the duration is a `performance.now()` delta, and the two clocks disagree by a
 * small fixed offset — so a real fired 5 s deadline lands at or below 5.000 s a fair fraction of the
 * time (measured: worst case 0.63 ms early; the end-to-end test asserting otherwise failed ~20-25%
 * of runs). Even with perfect clocks the two populations are arbitrarily close in duration, and the
 * deadline is env-tunable, so no fixed bucket set can separate them for every deployment. The
 * separator is `outcome="timeout"`, which is a branch on the abort error, not on the duration.
 *
 * The end-to-end half — a real `AbortSignal.timeout` firing, classified `timeout`, recorded with the
 * real parked duration, landing in a FINITE bucket — is driven in
 * `src/server/integrations/__tests__/moderation.instrumentation.test.ts`. The two together are the
 * claim; keep them together if either moves.
 */
describe('the bucket SET keeps the EXTERNAL_MODERATION_TIMEOUT_MS deadline region readable', () => {
  /** The finite boundaries actually registered, read back off the REGISTRY that gets scraped. */
  async function finiteBoundaries() {
    // prom-client only emits bucket samples for label sets that have an observation, so materialise
    // the series first. Reading the boundaries back off the REGISTRY (rather than off an exported
    // constant) is deliberate: it is the set that will actually be scraped.
    observeExternalModeration('generate', 'ok', 0.001);
    const vals = await samples(HIST);
    return [
      ...new Set(
        vals
          .filter((v) => v.metricName === `${HIST}_bucket`)
          .map((v) => Number(v.labels.le))
          .filter((n) => Number.isFinite(n))
      ),
    ].sort((a, b) => a - b);
  }

  it('puts NO finite boundary on the default deadline, so one timeout mode is not split in two', async () => {
    const boundaries = await finiteBoundaries();

    expect(boundaries.length).toBeGreaterThan(0);
    expect(
      boundaries.filter((b) => b === CAP_SECONDS),
      `a boundary sitting exactly on the ${CAP_SECONDS}s default deadline splits the single ` +
        'outcome=timeout population across two buckets by a sub-millisecond clock race, so a ' +
        'dashboard renders one mode as two. The boundaries around the cap (4.5, 7.5) are placed to ' +
        'CLEAR the default deadline, not because any value is intrinsically safe — 4.5s is 4500ms, ' +
        'which a deployment can configure. This is a dashboard-readability guard ONLY: it cannot ' +
        'hold for an arbitrary env-tuned deadline, and nothing about CLASSIFYING a capped call ' +
        'depends on it — that is the outcome label.'
    ).toEqual([]);
  });

  it('has a finite boundary ABOVE the deadline, so a capped call is not swallowed by +Inf', async () => {
    const boundaries = await finiteBoundaries();

    expect(boundaries.length).toBeGreaterThan(0);
    // 🔴 THE PROPERTY THAT IS SOUND AND STAYS SOUND. Unlike the separate-the-two-populations claim
    // this file used to make, this one does not depend on any clock: a top finite bucket at or below
    // the cap drops EVERY capped call into +Inf alongside every pathological one, saturating
    // precisely the region the metric was added to read, whatever the durations happen to be.
    expect(
      Math.max(...boundaries),
      `the top finite boundary must exceed the ${CAP_SECONDS}s deadline, or every capped call is ` +
        'swallowed by +Inf together with every pathological one and the tail becomes unreadable'
    ).toBeGreaterThan(CAP_SECONDS);
    // …and there must be a boundary strictly between the cap and the top, or "capped" and
    // "pathologically over the cap" still share a bucket.
    expect(
      boundaries.filter((b) => b > CAP_SECONDS).length,
      'at least two finite boundaries must sit above the deadline, or a capped call and a ' +
        'pathologically-over-the-cap call share the last finite bucket'
    ).toBeGreaterThanOrEqual(2);
  });

  it('resolves the healthy sub-second population instead of collapsing it into one bucket', async () => {
    const boundaries = await finiteBoundaries();

    // A single outbound HTTPS POST lives in tens-to-hundreds of ms; apportioning a per-call budget
    // of that size needs boundaries below 100ms, not a first boundary at half a second.
    expect(
      boundaries.filter((b) => b <= 0.1).length,
      'at least three boundaries must sit at or below 100ms, or the healthy tens-to-hundreds-of-ms ' +
        'population collapses into one bucket and the metric cannot apportion a per-call budget'
    ).toBeGreaterThanOrEqual(3);
  });
});

describe('recordExternalModerationSkipped', () => {
  it('counts the not-configured short-circuit on its own counter', async () => {
    recordExternalModerationSkipped('generate');
    recordExternalModerationSkipped('generate');

    expect(await skippedCount('generate')).toBe(2);
  });

  it('does NOT touch the duration histogram (no I/O happened, so it is not a latency sample)', async () => {
    recordExternalModerationSkipped('generate');

    expect(await histCount('generate', 'ok')).toBe(0);
    expect(await histCount('generate', 'error')).toBe(0);
    expect(await histCount('generate', 'timeout')).toBe(0);
  });

  it('clamps its source and never throws', async () => {
    expect(() => recordExternalModerationSkipped('nope' as never)).not.toThrow();
    expect(await skippedCount('other')).toBe(1);
  });
});
