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

// Pure unit test: this module imports only prom-client (no env / Prisma / DB), so
// nothing here boots the app graph. Values are read back off the default registry —
// the same registry `/api/metrics` serves — rather than off the counter object the
// module happens to hold, so a counter registered on the WRONG registry fails here
// instead of passing on an in-memory handle nothing scrapes.

type MetricJSON = { values: { value: number; labels: Record<string, string> }[] };

async function seriesFromRegistry(): Promise<Record<string, number>> {
  const metric = client.register.getSingleMetric(IMAGE_UPLOAD_RELAY_METRIC) as unknown as
    | { get: () => Promise<MetricJSON> }
    | undefined;
  if (!metric) return {};
  const data = await metric.get();
  return Object.fromEntries(data.values.map((v) => [v.labels.outcome, v.value]));
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

  it('is idempotent: re-registering neither throws nor resets counts', async () => {
    // prom-client throws on a duplicate metric name, and Next can evaluate a module
    // twice (HMR / route bundling). It is also called on every scrape, so a seeding
    // pass that zeroed live counts would erase the evidence between scrapes.
    ensureRegisterImageUploadRelayMetrics();
    recordImageUploadRelay('success');
    recordImageUploadRelay('success');
    expect(() => ensureRegisterImageUploadRelayMetrics()).not.toThrow();
    expect((await seriesFromRegistry()).success).toBe(2);
  });

  it('holds the cardinality bound at exactly one label over a closed union', async () => {
    // 🔴 A RELATIONSHIP, not a magic number: series-per-pod = |outcomes|, and nothing
    // caller-supplied may widen it. Adding a second label, or one carrying a user id /
    // key / host / size, fails this.
    ensureRegisterImageUploadRelayMetrics();
    const metric = client.register.getSingleMetric(IMAGE_UPLOAD_RELAY_METRIC) as unknown as {
      labelNames: string[];
      get: () => Promise<MetricJSON>;
    };
    expect(metric.labelNames).toEqual(['outcome']);
    const { values } = await metric.get();
    expect(values).toHaveLength(IMAGE_UPLOAD_RELAY_OUTCOMES.length);
    for (const v of values) expect(Object.keys(v.labels)).toEqual(['outcome']);
  });
});

describe('recordImageUploadRelay', () => {
  it('increments the named outcome AND ONLY that one', async () => {
    // The "and only that one" half is what a hardcoded label value fails: a mutant
    // that always writes `success` still increments something, so asserting a single
    // outcome moved would pass it.
    recordImageUploadRelay('too_large');
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
      for (let k = 0; k < n; k++) recordImageUploadRelay(outcome);
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
    recordImageUploadRelay('surprise' as unknown as ImageUploadRelayOutcome);
    recordImageUploadRelay('' as unknown as ImageUploadRelayOutcome);
    recordImageUploadRelay(undefined as unknown as ImageUploadRelayOutcome);
    const series = await seriesFromRegistry();
    expect(Object.keys(series).sort()).toEqual([...IMAGE_UPLOAD_RELAY_OUTCOMES].sort());
    for (const outcome of IMAGE_UPLOAD_RELAY_OUTCOMES) {
      expect(series[outcome], `outcome=${outcome}`).toBe(0);
    }
  });

  it('never throws — a metrics failure must not break the upload it is observing', async () => {
    // This route runs only AFTER the user's direct upload has already failed. An
    // exception escaping the emitter would turn the rescue into the outage.
    const metric = client.register.getSingleMetric(IMAGE_UPLOAD_RELAY_METRIC) as unknown as {
      inc: (labels: Record<string, string>, value?: number) => void;
    };
    ensureRegisterImageUploadRelayMetrics();
    const realInc = metric.inc;
    metric.inc = () => {
      throw new Error('registry exploded');
    };
    try {
      expect(() => recordImageUploadRelay('success')).not.toThrow();
    } finally {
      metric.inc = realInc;
    }
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
