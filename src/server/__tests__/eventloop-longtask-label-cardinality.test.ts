import { describe, it, expect, vi } from 'vitest';
import type client from 'prom-client';

// ---------------------------------------------------------------------------
// WHY THIS TEST EXISTS
//
// The labeled attribution tier emits `label` straight from whatever string a call
// site passed to runWithLongTaskLabel. That was bounded by CONVENTION only — the
// docblock asserted "never an unbounded value" and nothing enforced it. The
// asyncId->label map cap (and eventloop_longtask_labeled_evicted_total) bounds
// MEMORY, not Prometheus cardinality: they are different limits, and only the first
// one existed. One call site interpolating an id into a label would have created an
// unbounded series family on a counter AND a 13-series-per-value histogram.
//
// These tests pin the structural bound: distinct emitted labels per process can
// never exceed LONGTASK_LABEL_CARDINALITY_MAX, whatever the callers do.
// ---------------------------------------------------------------------------

const { cardTestRegistry } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const promClient = require('prom-client');
  return { cardTestRegistry: new promClient.Registry() as client.Registry };
});

vi.mock('~/server/prom/client', () => {
  function registerInstrumentationMetric<M extends client.Metric<string>>(
    name: string,
    factory: () => M
  ): M {
    const existing = cardTestRegistry.getSingleMetric(name);
    if (existing) return existing as unknown as M;
    return factory();
  }
  return {
    instrumentationRegistry: cardTestRegistry,
    registerInstrumentationMetric,
    registerCounter: () => ({ inc: vi.fn() }),
    registerHistogram: () => ({ observe: vi.fn() }),
  };
});

vi.mock('~/server/logging/client', () => ({
  logToAxiom: vi.fn().mockResolvedValue(undefined),
}));

import {
  createLabelAdmitter,
  recordLabeledBlock,
  __setLongTaskLabelAdmitterForTests,
  LONGTASK_LABEL_CARDINALITY_MAX,
  LONGTASK_LABEL_CARDINALITY_DEFAULT,
  LONGTASK_LABEL_OVERFLOW,
  LONGTASK_LABEL_PREFIXES,
} from '~/server/eventloop-longtask';

const PREFIX = 'civitai_app_';
const LABELED_COUNTER = PREFIX + 'eventloop_longtask_labeled_total';
const LABELED_HISTOGRAM = PREFIX + 'eventloop_longtask_labeled_duration_seconds';
const CAPPED_COUNTER = PREFIX + 'eventloop_longtask_label_capped_total';
// The drift (loop-level, 'unlabeled') series the cap must leave completely alone.
const DRIFT_COUNTER = PREFIX + 'eventloop_longtask_total';
const DRIFT_HISTOGRAM = PREFIX + 'eventloop_longtask_duration_seconds';

const recordOpts = { logMinMs: 50, threshold: 50, logPerMin: 0 };

function counter(name: string): client.Counter<string> | undefined {
  return cardTestRegistry.getSingleMetric(name) as client.Counter<string> | undefined;
}

async function distinctLabels(name: string): Promise<string[]> {
  const metric = cardTestRegistry.getSingleMetric(name) as
    | client.Counter<string>
    | client.Histogram<string>
    | undefined;
  if (!metric) return [];
  const { values } = await metric.get();
  return [...new Set(values.map((v) => String(v.labels.label)))].sort();
}

async function counterValue(name: string, label?: string): Promise<number> {
  const metric = counter(name);
  if (!metric) return NaN;
  const { values } = await metric.get();
  const matched = label === undefined ? values : values.filter((v) => v.labels.label === label);
  return matched.reduce((sum, v) => sum + v.value, 0);
}

describe('eventloop-longtask label cardinality: the admitter caps the distinct label set', () => {
  it('admits a label carrying a known prefix as its own series', () => {
    const admitter = createLabelAdmitter(16);
    expect(admitter.admit('trpc:image.getInfinite')).toBe('trpc:image.getInfinite');
    expect(admitter.admit('rest:/api/v1/images')).toBe('rest:/api/v1/images');
    expect(admitter.admit('job:metrics-update')).toBe('job:metrics-update');
  });

  it('every declared prefix is actually admitted (the allow-list is not aspirational)', () => {
    for (const prefix of LONGTASK_LABEL_PREFIXES) {
      const admitter = createLabelAdmitter(16);
      const label = `${prefix}something`;
      expect(admitter.admit(label), `prefix ${prefix} must be admitted`).toBe(label);
    }
  });

  // THE TEST THAT MATTERS: drive past the cap and watch it engage.
  it('collapses every label beyond the cap into the overflow bucket', () => {
    let overflows = 0;
    const CAP = 4; // 3 real labels + the seeded overflow bucket
    const admitter = createLabelAdmitter(CAP, () => overflows++);

    expect(admitter.admit('trpc:a')).toBe('trpc:a');
    expect(admitter.admit('trpc:b')).toBe('trpc:b');
    expect(admitter.admit('trpc:c')).toBe('trpc:c');
    expect(admitter.size()).toBe(CAP);
    expect(overflows).toBe(0);

    // The 4th distinct label has no slot left.
    expect(admitter.admit('trpc:d')).toBe(LONGTASK_LABEL_OVERFLOW);
    expect(overflows).toBe(1);
    // An already-admitted label still resolves to itself after the cap is reached.
    expect(admitter.admit('trpc:a')).toBe('trpc:a');
    expect(overflows).toBe(1);
  });

  it('stays at the cap under a flood of distinct labels', () => {
    let overflows = 0;
    const CAP = 8;
    const admitter = createLabelAdmitter(CAP, () => overflows++);
    const emitted = new Set<string>();
    for (let i = 0; i < 5_000; i++) emitted.add(admitter.admit(`trpc:route.${i}`));

    expect(admitter.size()).toBe(CAP);
    // The emitted set is what Prometheus would see: cap distinct values, no more.
    expect(emitted.size).toBeLessThanOrEqual(CAP);
    expect(emitted.has(LONGTASK_LABEL_OVERFLOW)).toBe(true);
    expect(overflows).toBe(5_000 - (CAP - 1));
  });

  it('clamps an over-large configured cap to LONGTASK_LABEL_CARDINALITY_MAX', () => {
    const admitter = createLabelAdmitter(10_000);
    for (let i = 0; i < LONGTASK_LABEL_CARDINALITY_MAX + 500; i++) {
      admitter.admit(`trpc:route.${i}`);
    }
    expect(admitter.size()).toBe(LONGTASK_LABEL_CARDINALITY_MAX);
  });

  it('the default cap is within the hard ceiling', () => {
    expect(LONGTASK_LABEL_CARDINALITY_DEFAULT).toBeLessThanOrEqual(LONGTASK_LABEL_CARDINALITY_MAX);
    expect(LONGTASK_LABEL_CARDINALITY_DEFAULT).toBeGreaterThan(1);
  });
});

describe('eventloop-longtask label cardinality: unknown label shapes never consume a slot', () => {
  it('collapses a label with no known prefix WITHOUT spending capacity', () => {
    let overflows = 0;
    const CAP = 3; // overflow + 2 real slots
    const admitter = createLabelAdmitter(CAP, () => overflows++);

    // A hundred junk labels — if these consumed slots, the real routes below would
    // be evicted into `other`, which is the poisoning failure this guards.
    for (let i = 0; i < 100; i++) {
      expect(admitter.admit(`user-${i}:whatever`)).toBe(LONGTASK_LABEL_OVERFLOW);
    }
    expect(overflows).toBe(100);
    expect(admitter.size()).toBe(1);

    expect(admitter.admit('trpc:image.getInfinite')).toBe('trpc:image.getInfinite');
    expect(admitter.admit('rest:/api/v1/images')).toBe('rest:/api/v1/images');
    expect(admitter.size()).toBe(CAP);
  });

  it('collapses a bare prefix with no remainder', () => {
    const admitter = createLabelAdmitter(16);
    expect(admitter.admit('trpc:')).toBe(LONGTASK_LABEL_OVERFLOW);
  });

  it('collapses an over-length label rather than truncating it into a collision', () => {
    const admitter = createLabelAdmitter(16);
    expect(admitter.admit(`trpc:${'x'.repeat(200)}`)).toBe(LONGTASK_LABEL_OVERFLOW);
  });

  it('collapses a label carrying characters outside the route/job charset', () => {
    const admitter = createLabelAdmitter(16);
    // An interpolated free-text value — spaces, quotes, braces.
    expect(admitter.admit('trpc:image.get?q={"a": 1}')).toBe(LONGTASK_LABEL_OVERFLOW);
    expect(admitter.admit('rest:/api/v1/images\n')).toBe(LONGTASK_LABEL_OVERFLOW);
  });

  it('does not collapse the legitimate route/job charset', () => {
    const admitter = createLabelAdmitter(16);
    for (const label of [
      'trpc:image.getInfinite',
      'trpc:model.getById',
      'rest:/api/v1/images',
      'job:new-order-grant-bless-buzz',
      'job:metrics_update.v2',
    ]) {
      expect(admitter.admit(label), `${label} must be admitted`).toBe(label);
    }
  });
});

describe('eventloop-longtask label cardinality: enforcement reaches the REGISTERED metrics', () => {
  it('recordLabeledBlock emits at most `cap` distinct label values and counts the collapse', async () => {
    counter(LABELED_COUNTER)?.reset();
    counter(CAPPED_COUNTER)?.reset();
    const CAP = 3; // overflow + 2 real slots
    const restore = __setLongTaskLabelAdmitterForTests(CAP);
    try {
      for (let i = 0; i < 50; i++) recordLabeledBlock(120, `trpc:flood.${i}`, recordOpts);
    } finally {
      restore();
    }

    const labels = await distinctLabels(LABELED_COUNTER);
    expect(labels.length, `emitted labels: ${labels.join(', ')}`).toBeLessThanOrEqual(CAP);
    expect(labels).toContain(LONGTASK_LABEL_OVERFLOW);
    // The histogram is the expensive family (buckets x labels) — cap it too.
    expect((await distinctLabels(LABELED_HISTOGRAM)).length).toBeLessThanOrEqual(CAP);
    // 50 blocks, 2 admitted labels => 48 collapsed.
    expect(await counterValue(CAPPED_COUNTER)).toBe(48);
    // Every block is still counted, just under fewer labels.
    expect(await counterValue(LABELED_COUNTER)).toBe(50);
  });

  it('an admitted label does NOT increment the capped counter (negative control)', async () => {
    counter(CAPPED_COUNTER)?.reset();
    const restore = __setLongTaskLabelAdmitterForTests(16);
    try {
      recordLabeledBlock(310, 'trpc:model.getById', recordOpts);
      recordLabeledBlock(310, 'trpc:model.getById', recordOpts);
    } finally {
      restore();
    }
    expect(await counterValue(CAPPED_COUNTER)).toBe(0);
    expect(await counterValue(LABELED_COUNTER, 'trpc:model.getById')).toBeGreaterThanOrEqual(2);
    const scraped = await cardTestRegistry.getSingleMetricAsString(LABELED_HISTOGRAM);
    expect(scraped).toContain('label="trpc:model.getById"');
  });

  it('leaves the drift (unlabeled) series untouched — the cap changes no existing shape', async () => {
    const driftCtrBefore = await counterValue(DRIFT_COUNTER);
    const driftLabelsBefore = await distinctLabels(DRIFT_HISTOGRAM);
    const restore = __setLongTaskLabelAdmitterForTests(2);
    try {
      recordLabeledBlock(700, 'trpc:some.route', recordOpts);
      recordLabeledBlock(700, 'trpc:another.route', recordOpts);
    } finally {
      restore();
    }
    expect(await counterValue(DRIFT_COUNTER)).toBe(driftCtrBefore);
    expect(await distinctLabels(DRIFT_HISTOGRAM)).toEqual(driftLabelsBefore);
  });
});
