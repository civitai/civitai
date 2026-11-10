import client from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REDIS_COMMAND_DURATION_BUCKETS, redisCommandDuration } from '../client';
import {
  batchedDurationHistogram,
  batchedInflightGauge,
  setRedisCommandHistogramBatchGate,
} from '../redis-command-metrics';

/**
 * The batched handles for the per-command redis metrics must export exactly what per-command
 * prom-client calls export. Each case feeds one metric through the handle and a twin metric through
 * prom-client directly, with the same inputs, and compares the scraped text line for line.
 *
 * Durations are dyadic fractions so a sum is exact whatever order it is added in, and include values
 * exactly ON a bucket bound (prom-client's buckets are inclusive), between bounds, and above the top
 * bound (+Inf only). Two `client` label values are used so a sample landing on the wrong label fails.
 */

const BUCKETS = REDIS_COMMAND_DURATION_BUCKETS;
const SAMPLES: [string, number][] = [
  ['cluster', 0.0009765625], // <= 0.001
  ['cluster', 0.5], // exactly on a bound
  ['cluster', 1],
  ['sys', 0.0078125], // <= 0.025
  ['cluster', 0.25],
  ['sys', 2],
  ['cluster', 31], // above 30: +Inf only
  ['cluster', 4],
  ['sys', 0.5],
];

let n = 0;
function histograms() {
  const registry = new client.Registry();
  const id = ++n;
  const make = (name: string) =>
    new client.Histogram({
      name,
      help: 'h',
      labelNames: ['client'],
      buckets: [...BUCKETS],
      registers: [registry],
    });
  const direct = make(`direct_${id}`);
  const batched = make(`batched_${id}`);
  const text = async () => ({
    direct: (await registry.getSingleMetricAsString(`direct_${id}`)).replaceAll(
      `direct_${id}`,
      'm'
    ),
    batched: (await registry.getSingleMetricAsString(`batched_${id}`)).replaceAll(
      `batched_${id}`,
      'm'
    ),
  });
  return { registry, direct, batched, text };
}

afterEach(() => {
  setRedisCommandHistogramBatchGate(undefined);
  vi.restoreAllMocks();
});

describe('batchedDurationHistogram', () => {
  it('gate on: nothing reaches prom-client per command, and the scrape matches per-command observes', async () => {
    const h = histograms();
    setRedisCommandHistogramBatchGate(() => true);
    const handle = batchedDurationHistogram(h.batched, BUCKETS);
    const observe = vi.spyOn(h.batched, 'observe');

    for (const [c, v] of SAMPLES) {
      handle.observe({ client: c }, v);
      h.direct.observe({ client: c }, v);
    }
    expect(observe).not.toHaveBeenCalled();

    const { direct, batched } = await h.text();
    // Positive control: the direct twin really holds the samples.
    expect(direct).toContain('m_count{client="cluster"} 6');
    expect(direct).toContain('m_count{client="sys"} 3');
    expect(direct).toContain('m_bucket{le="30",client="cluster"} 5');
    expect(batched).toBe(direct);
  });

  it('no gate, or gate off: every observe goes straight to prom-client', async () => {
    for (const gate of [undefined, () => false]) {
      const h = histograms();
      setRedisCommandHistogramBatchGate(gate);
      const handle = batchedDurationHistogram(h.batched, BUCKETS);
      const observe = vi.spyOn(h.batched, 'observe');
      for (const [c, v] of SAMPLES) {
        handle.observe({ client: c }, v);
        h.direct.observe({ client: c }, v);
      }
      expect(observe).toHaveBeenCalledTimes(SAMPLES.length);
      const { direct, batched } = await h.text();
      expect(batched).toBe(direct);
    }
  });

  it('a throwing gate reads as off', async () => {
    const h = histograms();
    setRedisCommandHistogramBatchGate(() => {
      throw new Error('flag read failed');
    });
    const handle = batchedDurationHistogram(h.batched, BUCKETS);
    const observe = vi.spyOn(h.batched, 'observe');
    handle.observe({ client: 'cluster' }, 0.5);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('a flip mid-stream and repeated scrapes lose nothing and count nothing twice', async () => {
    const h = histograms();
    let on = true;
    setRedisCommandHistogramBatchGate(() => on);
    const handle = batchedDurationHistogram(h.batched, BUCKETS);

    const feed = (samples: [string, number][]) => {
      for (const [c, v] of samples) {
        handle.observe({ client: c }, v);
        h.direct.observe({ client: c }, v);
      }
    };
    feed(SAMPLES.slice(0, 4));
    let t = await h.text();
    expect(t.batched).toBe(t.direct);

    feed(SAMPLES.slice(4, 6)); // batched, not yet scraped
    on = false;
    feed(SAMPLES.slice(6)); // straight through
    t = await h.text();
    expect(t.batched).toBe(t.direct);

    // A third scrape with nothing new changes nothing.
    t = await h.text();
    expect(t.batched).toBe(t.direct);
    expect(t.direct).toContain('m_count{client="cluster"} 6');
  });

  it('two wrappers of one histogram (two bundled copies) share one accumulator', async () => {
    const h = histograms();
    setRedisCommandHistogramBatchGate(() => true);
    const a = batchedDurationHistogram(h.batched, BUCKETS);
    const b = batchedDurationHistogram(h.batched, BUCKETS);
    for (const [i, [c, v]] of SAMPLES.entries()) {
      (i % 2 ? a : b).observe({ client: c }, v);
      h.direct.observe({ client: c }, v);
    }
    const { direct, batched } = await h.text();
    expect(batched).toBe(direct);
  });

  it('a flush that meets an unexpected layout stops batching instead of failing the scrape', async () => {
    const h = histograms();
    setRedisCommandHistogramBatchGate(() => true);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Bounds that do not match the histogram's own buckets.
    const handle = batchedDurationHistogram(h.batched, [1, 2]);
    handle.observe({ client: 'cluster' }, 0.5);

    await expect(h.registry.metrics()).resolves.toContain('batched_');
    expect(error).toHaveBeenCalledTimes(1);

    const observe = vi.spyOn(h.batched, 'observe');
    handle.observe({ client: 'cluster' }, 0.5);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('the real redis_command_duration_seconds histogram takes the exported buckets', async () => {
    setRedisCommandHistogramBatchGate(() => true);
    const error = vi.spyOn(console, 'error');
    const handle = batchedDurationHistogram(redisCommandDuration, REDIS_COMMAND_DURATION_BUCKETS);
    handle.observe({ client: 'bucket-probe' }, 0.0078125);
    const text = await client.register.getSingleMetricAsString(
      'civitai_app_redis_command_duration_seconds'
    );
    expect(text).toContain(
      'civitai_app_redis_command_duration_seconds_bucket{le="0.025",client="bucket-probe"} 1'
    );
    expect(text).toContain(
      'civitai_app_redis_command_duration_seconds_bucket{le="0.005",client="bucket-probe"} 0'
    );
    expect(text).toContain(
      'civitai_app_redis_command_duration_seconds_count{client="bucket-probe"} 1'
    );
    expect(error).not.toHaveBeenCalled();
  });
});

describe('batchedInflightGauge', () => {
  it('the scraped value per client equals per-command inc/dec, including below zero', async () => {
    const registry = new client.Registry();
    const make = (name: string) =>
      new client.Gauge({ name, help: 'g', labelNames: ['client'], registers: [registry] });
    const direct = make('gauge_direct');
    const batched = make('gauge_batched');
    const handle = batchedInflightGauge(batched);
    const inc = vi.spyOn(batched, 'inc');
    const dec = vi.spyOn(batched, 'dec');

    const ops: ['inc' | 'dec', string][] = [
      ['inc', 'cluster'],
      ['inc', 'cluster'],
      ['inc', 'sys'],
      ['inc', 'cluster'],
      ['dec', 'cluster'],
      ['dec', 'sys'],
      ['dec', 'sys'], // an unmatched dec, as a prom gauge would show it
    ];
    const run = (slice: typeof ops) => {
      for (const [op, c] of slice) {
        handle[op]({ client: c });
        direct[op]({ client: c });
      }
    };
    const text = async () => ({
      direct: (await registry.getSingleMetricAsString('gauge_direct')).replaceAll(
        'gauge_direct',
        'g'
      ),
      batched: (await registry.getSingleMetricAsString('gauge_batched')).replaceAll(
        'gauge_batched',
        'g'
      ),
    });

    run(ops.slice(0, 4));
    let t = await text();
    expect(t.direct).toContain('g{client="cluster"} 3');
    expect(t.batched).toBe(t.direct);

    run(ops.slice(4));
    t = await text();
    expect(t.direct).toContain('g{client="cluster"} 2');
    expect(t.direct).toContain('g{client="sys"} -1');
    expect(t.batched).toBe(t.direct);

    // Never per command.
    expect(inc).not.toHaveBeenCalled();
    expect(dec).not.toHaveBeenCalled();
  });

  it('a client label never touched has no series, as before', async () => {
    const registry = new client.Registry();
    const g = new client.Gauge({
      name: 'gauge_untouched',
      help: 'g',
      labelNames: ['client'],
      registers: [registry],
    });
    const handle = batchedInflightGauge(g);
    handle.inc({ client: 'cluster' });
    const text = await registry.getSingleMetricAsString('gauge_untouched');
    expect(text).toContain('gauge_untouched{client="cluster"} 1');
    expect(text).not.toContain('client="sys"');
  });
});
