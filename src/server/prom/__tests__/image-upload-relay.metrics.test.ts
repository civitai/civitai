import { describe, it, expect, beforeEach } from 'vitest';
import client from 'prom-client';
import {
  IMAGE_UPLOAD_RELAY_METRIC,
  IMAGE_UPLOAD_RELAY_OUTCOMES,
  ensureRegisterImageUploadRelayMetrics,
  isImageUploadRelayOutcome,
  recordImageUploadRelay,
  __resetImageUploadRelayMetricsForTest,
  type ImageUploadRelayOutcome,
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
  it('registers on the DEFAULT registry, which is the one /api/metrics scrapes', async () => {
    ensureRegisterImageUploadRelayMetrics();
    // Not "the function returned a counter" — a counter on a private registry would
    // satisfy that and be scraped by nothing.
    expect(client.register.getSingleMetric(IMAGE_UPLOAD_RELAY_METRIC)).toBeDefined();
    expect(await seriesFromRegistry()).toHaveProperty('success');
  });

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

  it('🔴 SEEDS THE FULL CROSS PRODUCT — every outcome x every producer, at 0', async () => {
    // 🔴 THE PROPERTY THE PRODUCER LABEL COULD HAVE BROKEN. Seeding the outcomes alone
    // (each under one default producer) leaves
    // `…{outcome="success",producer="multipart"}` ABSENT until the multipart path's first
    // real rescue — so PromQL answers `no data`, which is indistinguishable from "that
    // caller is not wired up". That is the same ambiguity the seeding exists to remove,
    // reintroduced one level down, on exactly the question the label was added to settle.
    //
    // Enumerated as a cross product rather than as a count, so the case cannot be
    // satisfied by the right NUMBER of series carrying the wrong LABELS.
    ensureRegisterImageUploadRelayMetrics();
    const rows = await seriesByLabels();
    const seen = new Set(rows.map((r) => `${r.outcome}|${r.producer}`));
    for (const outcome of IMAGE_UPLOAD_RELAY_OUTCOMES) {
      for (const producer of IMAGE_UPLOAD_RELAY_PRODUCERS) {
        expect(seen.has(`${outcome}|${producer}`), `${outcome}|${producer} must be seeded`).toBe(
          true
        );
      }
    }
    // Exactly the cross product: no more (a leak) and no fewer (a gap).
    expect(rows).toHaveLength(
      IMAGE_UPLOAD_RELAY_OUTCOMES.length * IMAGE_UPLOAD_RELAY_PRODUCERS.length
    );
    expect(rows.every((r) => r.value === 0)).toBe(true);
  });

  it('seeds `unknown` like any other producer — it is the ROLLOUT reading, not a gap', async () => {
    // 🔴 Called out separately from the cross-product case because it is the series that
    // will carry nearly all the traffic immediately after this ships: a browser on an
    // older cached bundle sends no header. If `unknown` were treated as an error bucket
    // and left unseeded, the first weeks of rollout would read as `no data` on the only
    // row that was moving.
    ensureRegisterImageUploadRelayMetrics();
    const unknownRows = (await seriesByLabels()).filter((r) => r.producer === 'unknown');
    expect(unknownRows).toHaveLength(IMAGE_UPLOAD_RELAY_OUTCOMES.length);
    expect(unknownRows.every((r) => r.value === 0)).toBe(true);
  });

  it('is idempotent: re-registering neither throws nor resets counts', async () => {
    // prom-client throws on a duplicate metric name, and Next can evaluate a module
    // twice (HMR / route bundling). It is also called on every scrape, so a seeding
    // pass that zeroed live counts would erase the evidence between scrapes.
    ensureRegisterImageUploadRelayMetrics();
    recordImageUploadRelay('success', 'single_put');
    recordImageUploadRelay('success', 'single_put');
    expect(() => ensureRegisterImageUploadRelayMetrics()).not.toThrow();
    expect((await seriesFromRegistry()).success).toBe(2);
  });

  it('holds the cardinality bound at exactly two labels over two closed unions', async () => {
    // 🔴 A RELATIONSHIP, not a magic number: series-per-pod = |outcomes| x |producers|,
    // and nothing caller-supplied may widen it. Adding a third label, or one carrying a
    // user id / key / host / size, fails this — including the tempting ones, since the
    // producer header arrives on the same request as a Content-Type and a user session.
    ensureRegisterImageUploadRelayMetrics();
    const metric = client.register.getSingleMetric(IMAGE_UPLOAD_RELAY_METRIC) as unknown as {
      labelNames: string[];
      get: () => Promise<MetricJSON>;
    };
    expect([...metric.labelNames].sort()).toEqual(['outcome', 'producer']);
    const { values } = await metric.get();
    expect(values).toHaveLength(
      IMAGE_UPLOAD_RELAY_OUTCOMES.length * IMAGE_UPLOAD_RELAY_PRODUCERS.length
    );
    for (const v of values) expect(Object.keys(v.labels).sort()).toEqual(['outcome', 'producer']);
  });
});

describe('recordImageUploadRelay', () => {
  it('increments the named outcome AND ONLY that one', async () => {
    // The "and only that one" half is what a hardcoded label value fails: a mutant
    // that always writes `success` still increments something, so asserting a single
    // outcome moved would pass it.
    recordImageUploadRelay('too_large', 'single_put');
    const series = await seriesFromRegistry();
    expect(series.too_large).toBe(1);
    for (const outcome of IMAGE_UPLOAD_RELAY_OUTCOMES) {
      if (outcome !== 'too_large') expect(series[outcome], `outcome=${outcome}`).toBe(0);
    }
  });

  it('keeps each outcome on its own series across a mixed sequence', async () => {
    // Every declared outcome is exercised at a DISTINCT count, so the assertion cannot
    // be satisfied by a constant, by a shifted mapping, or by two outcomes being
    // silently folded into one series.
    const expected = new Map<ImageUploadRelayOutcome, number>();
    IMAGE_UPLOAD_RELAY_OUTCOMES.forEach((outcome, i) => {
      const n = i + 1;
      expected.set(outcome, n);
      for (let k = 0; k < n; k++) recordImageUploadRelay(outcome, 'single_put');
    });
    const series = await seriesFromRegistry();
    for (const [outcome, n] of expected) expect(series[outcome], `outcome=${outcome}`).toBe(n);
  });

  it('DROPS an unknown outcome rather than relabelling it', async () => {
    // The cardinality bound rests on this runtime narrowing, not on the erased type.
    // 🔴 Two separate claims: no new series appears (the bound), and no EXISTING series
    // absorbs it (a fallback to `unknown` or, far worse, to `success` would invent
    // evidence that the relay rescued an upload).
    //
    // Seeded first so the assertion has a baseline to compare against: the narrowing
    // returns BEFORE registration, so without this the registry is simply empty and the
    // "no new series" check would pass vacuously against a mutant that dropped nothing.
    ensureRegisterImageUploadRelayMetrics();
    recordImageUploadRelay('surprise' as unknown as ImageUploadRelayOutcome, 'single_put');
    recordImageUploadRelay('' as unknown as ImageUploadRelayOutcome, 'single_put');
    recordImageUploadRelay(undefined as unknown as ImageUploadRelayOutcome, 'single_put');
    const series = await seriesFromRegistry();
    expect(Object.keys(series).sort()).toEqual([...IMAGE_UPLOAD_RELAY_OUTCOMES].sort());
    for (const outcome of IMAGE_UPLOAD_RELAY_OUTCOMES) {
      expect(series[outcome], `outcome=${outcome}`).toBe(0);
    }
  });

  it('🔴 NARROWS an unknown producer to `unknown` instead of dropping the increment', async () => {
    // 🔴 THE ASYMMETRY WITH THE CASE ABOVE, AND IT IS DELIBERATE. An outcome is
    // code-owned, so an unrecognised one is our own defect and is dropped. A producer is
    // CALLER-owned, so an unrecognised one is ordinary traffic — a stale bundle, a future
    // client, or someone poking at the route — and dropping the increment would mean a
    // caller could choose not to be counted. That breaks the counter's load-bearing
    // property that `sum()` equals the route's invocation count.
    //
    // Both halves are asserted: the invocation IS counted, and it is counted on the
    // `unknown` series rather than on an invented one.
    ensureRegisterImageUploadRelayMetrics();
    recordImageUploadRelay('success', 'chrome-extension://evil' as never);
    recordImageUploadRelay('success', undefined as never);
    recordImageUploadRelay('success', '' as never);

    const rows = await seriesByLabels();
    expect(rows).toHaveLength(
      IMAGE_UPLOAD_RELAY_OUTCOMES.length * IMAGE_UPLOAD_RELAY_PRODUCERS.length
    );
    // The string that arrived but is not a member lands in `other`; the two that carried
    // nothing usable land in `unknown`. Both are narrowings, neither is a drop.
    expect((await seriesForProducer('other')).success).toBe(1);
    expect((await seriesForProducer('unknown')).success).toBe(2);
    // And nowhere else: a narrowing that also leaked onto a real producer would make the
    // multipart figure include traffic that never came from it.
    expect((await seriesForProducer('multipart')).success).toBe(0);
    expect((await seriesForProducer('single_put')).success).toBe(0);
    // Every invocation is still counted — three in, three recorded. Dropping one would let
    // a caller choose not to be counted.
    expect((await seriesFromRegistry()).success).toBe(3);
  });

  it('keeps producers on SEPARATE series for the same outcome', async () => {
    // 🔴 The whole point of the label, and the case that fails if the producer is
    // hardcoded, folded, or dropped from the `inc` call: three distinct counts on one
    // outcome, none of them equal to another and none equal to the total.
    ensureRegisterImageUploadRelayMetrics();
    recordImageUploadRelay('success', 'single_put');
    recordImageUploadRelay('success', 'multipart');
    recordImageUploadRelay('success', 'multipart');
    recordImageUploadRelay('success', 'unknown');
    recordImageUploadRelay('success', 'unknown');
    recordImageUploadRelay('success', 'unknown');
    for (let i = 0; i < 4; i++) recordImageUploadRelay('success', 'other');

    // Four distinct counts on one outcome, none equal to another and none equal to the
    // total — so a constant, a shifted mapping and a fold are all visibly wrong here.
    expect((await seriesForProducer('single_put')).success).toBe(1);
    expect((await seriesForProducer('multipart')).success).toBe(2);
    expect((await seriesForProducer('unknown')).success).toBe(3);
    expect((await seriesForProducer('other')).success).toBe(4);
    // The summed view still reads as the route's invocation count — the property the
    // label must not cost us.
    expect((await seriesFromRegistry()).success).toBe(10);
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
    // `imageUploadRelayTotal.inc({ outcome })`, so it only proves the try/catch swallows
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
      expect(finalIncAttempts, 'the final inc({ outcome }) must have been reached').toBe(1);
    } finally {
      metric.inc = realInc;
    }
    // And the throw must not have left a phantom count behind.
    expect((await seriesFromRegistry()).success).toBe(0);
  });
});

describe('isImageUploadRelayOutcome', () => {
  it('accepts every declared outcome', () => {
    for (const outcome of IMAGE_UPLOAD_RELAY_OUTCOMES) {
      expect(isImageUploadRelayOutcome(outcome), outcome).toBe(true);
    }
  });

  it('rejects near-misses and non-strings', () => {
    // Near-misses rather than obvious junk: a guard built from a substring/prefix test
    // rather than set membership passes on `success_` and `succ`.
    for (const bad of ['success_', 'succ', 'SUCCESS', ' success', 'outcome', '', 'toString']) {
      expect(isImageUploadRelayOutcome(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const bad of [undefined, null, 0, 1, {}, [], true]) {
      expect(isImageUploadRelayOutcome(bad), String(bad)).toBe(false);
    }
  });
});
