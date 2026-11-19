import { describe, it, expect, beforeEach } from 'vitest';
import client from 'prom-client';
import {
  IMAGE_UPLOAD_RELAY_METRIC,
  IMAGE_UPLOAD_RELAY_OUTCOMES,
  ensureRegisterImageUploadRelayMetrics,
  recordImageUploadRelay,
  __resetImageUploadRelayMetricsForTest,
} from '~/server/prom/image-upload-relay.metrics';
import { IMAGE_UPLOAD_RELAY_PRODUCERS } from '~/utils/image-upload-relay-producer';

// Pure unit test: this module imports only prom-client (no env / Prisma / DB), so
// nothing here boots the app graph. Values are read back off the default registry —
// the same registry `/api/metrics` serves — rather than off the counter object the
// module happens to hold, so a counter registered on the WRONG registry fails here
// instead of passing on an in-memory handle nothing scrapes.

type MetricJSON = { values: { value: number; labels: Record<string, string> }[] };

/**
 * Counts keyed by OUTCOME, summed across producers.
 *
 * ⚠ The summing is deliberate and it is a LOSS: this view cannot see a wrong producer
 * label. It exists so the outcome-level cases below keep asserting the outcome claim they
 * were written for. Anything about the producer must read `seriesByLabels` instead.
 */
async function seriesFromRegistry(): Promise<Record<string, number>> {
  const byLabels = await seriesByLabels();
  const out: Record<string, number> = {};
  for (const { outcome, value } of byLabels) out[outcome] = (out[outcome] ?? 0) + value;
  return out;
}

/** Every child series, both labels intact. */
async function seriesByLabels(): Promise<{ outcome: string; producer: string; value: number }[]> {
  const metric = client.register.getSingleMetric(IMAGE_UPLOAD_RELAY_METRIC) as unknown as
    | { get: () => Promise<MetricJSON> }
    | undefined;
  if (!metric) return [];
  const data = await metric.get();
  return data.values.map((v) => ({
    outcome: v.labels.outcome,
    producer: v.labels.producer,
    value: v.value,
  }));
}

/** The counts for one producer, keyed by outcome. */
async function seriesForProducer(producer: string): Promise<Record<string, number>> {
  const rows = await seriesByLabels();
  return Object.fromEntries(
    rows.filter((r) => r.producer === producer).map((r) => [r.outcome, r.value])
  );
}

beforeEach(() => {
  __resetImageUploadRelayMetricsForTest();
});

describe('civitai_image_upload_relay_total registration', () => {
  it('SEEDS every outcome at 0 so an absent series cannot be mistaken for a real zero', async () => {
    // 🔴 The point of the whole module. The relay fires a handful of times across the
    // fleet, so on nearly every pod the true reading is all-zeros — and prom-client
    // materialises a child only on its first inc(). Without seeding, PromQL returns
    // `no data`, indistinguishable from "never deployed".
    ensureRegisterImageUploadRelayMetrics();
    const series = await seriesFromRegistry();
    for (const outcome of IMAGE_UPLOAD_RELAY_OUTCOMES) {
      expect(series[outcome], `outcome=${outcome} must be seeded`).toBe(0);
    }
    // And nothing beyond the declared union — a stray series is a cardinality leak.
    expect(Object.keys(series).sort()).toEqual([...IMAGE_UPLOAD_RELAY_OUTCOMES].sort());
  });
});

describe('recordImageUploadRelay', () => {
  it('🔴 NARROWS an unrecognised producer to a bucket instead of dropping the increment', async () => {
    // Bucketed, not dropped, so sum() still equals the route's invocation count; `unknown` is reserved for the request.
    ensureRegisterImageUploadRelayMetrics();
    recordImageUploadRelay('success', 'chrome-extension://evil' as never);
    recordImageUploadRelay('success', undefined as never);
    recordImageUploadRelay('success', '' as never);

    const rows = await seriesByLabels();
    expect(rows).toHaveLength(
      IMAGE_UPLOAD_RELAY_OUTCOMES.length * IMAGE_UPLOAD_RELAY_PRODUCERS.length
    );
    // 🔴 ALL THREE land in `other`, and the reason is a distinction this module had to
    // learn the hard way. The emitter's input is SERVER-derived — the route has already
    // sanitised the header — so a value that is not one of the four labels is OUR defect,
    // not a statement about the request. It must not land in `unknown`, which means "the
    // request carried no header" and is the row a rollout is graded on: letting our bugs
    // into it would inflate exactly the number someone reads as "stale bundles".
    expect((await seriesForProducer('other')).success).toBe(3);
    expect((await seriesForProducer('unknown')).success).toBe(0);
    // And nowhere else: a narrowing that also leaked onto a real producer would make the
    // multipart figure include traffic that never came from it.
    expect((await seriesForProducer('multipart')).success).toBe(0);
    expect((await seriesForProducer('single_put')).success).toBe(0);
    // Every invocation is still counted — three in, three recorded. Dropping one would let
    // a caller choose not to be counted.
    expect((await seriesFromRegistry()).success).toBe(3);
  });

  it('never throws — a metrics failure must not break the upload it is observing', async () => {
    // This route runs only AFTER the user's direct upload has already failed. An
    // exception escaping the emitter would turn the rescue into the outage.
    //
    // 🔴 REGISTER FIRST, then read the handle. The handle comes off the registry, so
    // reading it before the counter exists yields `undefined` and the case dies on the
    // stub setup rather than on its own claim. Written the other way round it passed
    // only because an earlier test in this file had already registered the counter —
    // i.e. by file ordering, not by construction. Verified: run alone
    // (`-t "never throws"`) the old order failed with
    // `TypeError: Cannot read properties of undefined (reading 'inc')`.
    ensureRegisterImageUploadRelayMetrics();
    const metric = client.register.getSingleMetric(IMAGE_UPLOAD_RELAY_METRIC) as unknown as {
      inc: (labels: Record<string, string>, value?: number) => void;
    };
    const realInc = metric.inc;

    // 🔴 Throw from the FINAL increment, not from the seeding pass. A stub that throws
    // on EVERY `inc` fires on `seedAllSeries`'s first call — inside
    // `ensureRegisterImageUploadRelayMetrics()` — and never reaches
    // `imageUploadRelayTotal.inc({ outcome, producer })`, so it only proves the try/catch swallows
    // *a* throw from somewhere in the emit path. The guard's actual claim is about the
    // increment. Seeding always passes a second argument (0) and the real increment
    // never does, which is what discriminates the two call sites.
    let finalIncAttempts = 0;
    metric.inc = (labels: Record<string, string>, value?: number) => {
      if (value === undefined) {
        finalIncAttempts += 1;
        throw new Error('registry exploded');
      }
      realInc.call(metric, labels, value);
    };
    try {
      expect(() => recordImageUploadRelay('success', 'single_put')).not.toThrow();
      // Positive control: without this, a stub that was never reached at all would let
      // the case pass as "the error was swallowed" having thrown nothing.
      expect(finalIncAttempts, 'the final inc({ outcome, producer }) must have been reached').toBe(
        1
      );
    } finally {
      metric.inc = realInc;
    }
    // And the throw must not have left a phantom count behind.
    expect((await seriesFromRegistry()).success).toBe(0);
  });
});
