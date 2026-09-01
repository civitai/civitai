/**
 * Contract tests for the external prompt-moderation metric family.
 *
 * These pin the three properties that make the family usable rather than merely present:
 *   1. the `source` label is CLOSED at runtime, not just in the type system — an options object
 *      built by spread can carry any string, and an unbounded label on a hot-path histogram is a
 *      cardinality incident, not a cosmetic bug;
 *   2. the BUCKET BOUNDARIES actually resolve the `EXTERNAL_MODERATION_TIMEOUT_MS` deadline — a
 *      call cut at the 5 s cap must land in a DIFFERENT bucket from one that answered just under
 *      it, which is the whole question ("slow gateway, or are we cutting it off?");
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

import {
  clampExternalModerationSource,
  isAbortDeadlineError,
  observeExternalModeration,
  recordExternalModerationSkipped,
} from '~/server/prom/external-moderation.metrics';

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

/** Cumulative bucket value at boundary `le` (prom histogram buckets are cumulative). */
async function histBucket(source: string, outcome: string, le: number) {
  const vals = await samples(HIST);
  return (
    vals.find(
      (v) =>
        v.metricName === `${HIST}_bucket` &&
        v.labels.source === source &&
        v.labels.outcome === outcome &&
        Number(v.labels.le) === le
    )?.value ?? 0
  );
}

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
    // The shape a spread-built options object produces: a value from somewhere else entirely.
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

describe('bucket boundaries resolve the EXTERNAL_MODERATION_TIMEOUT_MS deadline', () => {
  // The default deadline, in seconds (env: EXTERNAL_MODERATION_TIMEOUT_MS, default 5000).
  const CAP_SECONDS = 5;

  it('separates a call cut AT the deadline from one that answered just under it', async () => {
    observeExternalModeration('generate', 'ok', 4.9); // answered just under the cap
    observeExternalModeration('generate', 'ok', 5.02); // cut by the abort, observed just over

    // Buckets are cumulative: le=5 holds only the sub-cap call.
    expect(await histBucket('generate', 'ok', CAP_SECONDS)).toBe(1);
    // The next finite boundary above the cap holds both — i.e. exactly one landed between them.
    expect(await histBucket('generate', 'ok', 7.5)).toBe(2);
    expect(
      (await histBucket('generate', 'ok', 7.5)) - (await histBucket('generate', 'ok', CAP_SECONDS))
    ).toBe(1);
  });

  it('has a finite boundary ABOVE the deadline, so a capped call is not swallowed by +Inf', async () => {
    // prom-client only emits bucket samples for label sets that have an observation, so materialise
    // the series first. Reading the boundaries back off the REGISTRY (rather than off an exported
    // constant) is deliberate: it is the set that will actually be scraped.
    observeExternalModeration('generate', 'ok', 0.001);
    const vals = await samples(HIST);
    const boundaries = [
      ...new Set(
        vals
          .filter((v) => v.metricName === `${HIST}_bucket`)
          .map((v) => Number(v.labels.le))
          .filter((n) => Number.isFinite(n))
      ),
    ].sort((a, b) => a - b);

    expect(boundaries.length).toBeGreaterThan(0);
    // This is the failure the family was designed against: a top finite bucket at or below the cap
    // drops every capped call into +Inf alongside every pathological one, saturating precisely the
    // region the metric was added to read.
    expect(Math.max(...boundaries)).toBeGreaterThan(CAP_SECONDS);
    // …and there must be a boundary strictly between the cap and the top, or "capped" and
    // "pathologically over the cap" still share a bucket.
    expect(boundaries.filter((b) => b > CAP_SECONDS).length).toBeGreaterThanOrEqual(2);
  });

  it('resolves the healthy sub-second population instead of collapsing it into one bucket', async () => {
    observeExternalModeration('generate', 'ok', 0.001);
    const vals = await samples(HIST);
    const boundaries = [
      ...new Set(
        vals
          .filter((v) => v.metricName === `${HIST}_bucket`)
          .map((v) => Number(v.labels.le))
          .filter((n) => Number.isFinite(n))
      ),
    ];
    // A single outbound HTTPS POST lives in tens-to-hundreds of ms; apportioning a per-call budget
    // of that size needs boundaries below 100ms, not a first boundary at half a second.
    expect(boundaries.filter((b) => b <= 0.1).length).toBeGreaterThanOrEqual(3);
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
