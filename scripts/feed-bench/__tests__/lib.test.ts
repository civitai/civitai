import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * The feed benchmark harness's pure parts (scripts/feed-bench/lib.cjs). Every expectation is a
 * literal worked out by hand, never computed from the code under test. The mutant each case kills
 * is named on it.
 */

const require = createRequire(import.meta.url);
const lib = require('../lib.cjs');

describe('percentile / summarize (nearest rank)', () => {
  // Shuffled, so a missing sort is caught; spans a decimal order of magnitude, so a
  // lexicographic sort (`.sort()` without a comparator) is caught.
  const hundred = [
    100, 7, 55, 23, 91, 3, 68, 12, 84, 41, 29, 96, 60, 18, 75, 2, 47, 88, 33, 9, 64, 51, 26, 79, 14,
    93, 38, 70, 5, 58, 21, 86, 44, 1, 99, 31, 66, 16, 81, 49, 27, 73, 10, 95, 36, 62, 19, 77, 53, 6,
    90, 40, 24, 83, 57, 11, 69, 35, 98, 46, 15, 74, 28, 87, 50, 4, 63, 42, 92, 20, 80, 32, 67, 8,
    56, 97, 25, 72, 39, 13, 85, 61, 30, 94, 48, 17, 78, 43, 65, 22, 89, 54, 34, 82, 59, 37, 76, 45,
    71, 52,
  ];

  it('1..100 shuffled: p50 50, p95 95, p99 99 (kills: no sort, lexicographic sort)', () => {
    expect(hundred).toHaveLength(100);
    expect(lib.summarize(hundred)).toEqual({
      n: 100,
      min: 1,
      mean: 50.5,
      p50: 50,
      p95: 95,
      p99: 99,
      max: 100,
    });
  });

  it('odd count: the rank rounds UP (kills: Math.floor / Math.round rank)', () => {
    // rank(p50) = ceil(2.5) = 3 -> 30; floor would give 20.
    expect(lib.percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    // rank(p95) = ceil(4.75) = 5 -> 50; floor would give 40.
    expect(lib.percentile([10, 20, 30, 40, 50], 95)).toBe(50);
  });

  it('a single value is every percentile; empty is NaN (kills: off-by-one index)', () => {
    expect(lib.summarize([7])).toMatchObject({ p50: 7, p95: 7, p99: 7, min: 7, max: 7, mean: 7 });
    expect(lib.percentile([], 50)).toBeNaN();
    expect(lib.percentile([3, 9], 0)).toBe(3);
  });

  it('p99 of 1000 values is the 990th, not the max (kills: p99 aliased to max)', () => {
    const values = Array.from({ length: 1000 }, (_, i) => 1000 - i); // 1000..1
    expect(lib.summarize(values)).toMatchObject({ p99: 990, max: 1000, p50: 500 });
  });
});

describe('runOpenLoop (fixed rate, open loop)', () => {
  /** A fake clock: sleeping jumps time forward; nothing else moves it. */
  function clock() {
    let t = 1000;
    return {
      now: () => t,
      sleepUntil: async (until: number) => {
        t = Math.max(t, until);
      },
      advance: (ms: number) => (t += ms),
    };
  }

  it('sends item i at start + i*1000/rps (kills: rps inverted, off-by-one schedule)', async () => {
    const c = clock();
    const sentAt: number[] = [];
    const results = await lib.runOpenLoop({
      items: ['a', 'b', 'c', 'd', 'e'],
      rps: 4,
      now: c.now,
      sleepUntil: c.sleepUntil,
      send: async () => {
        sentAt.push(c.now());
        return { status: 200, latencyMs: 1 };
      },
    });
    expect(sentAt).toEqual([1000, 1250, 1500, 1750, 2000]);
    expect(results.map((r: { status: number }) => r.status)).toEqual([200, 200, 200, 200, 200]);
  });

  it('does not wait for an answer before the next send (kills: awaiting each send)', async () => {
    const c = clock();
    const sentAt: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = lib.runOpenLoop({
      items: [0, 1, 2],
      rps: 10,
      now: c.now,
      sleepUntil: c.sleepUntil,
      // No answer comes back until all three have been sent: a closed loop never gets past item 0.
      send: async () => {
        sentAt.push(c.now());
        if (sentAt.length === 3) release();
        await gate;
        return { status: 200, latencyMs: 5 };
      },
    });
    const outcome = await Promise.race([
      run.then(() => 'done'),
      new Promise((r) => setTimeout(() => r('stalled'), 1000)),
    ]);
    expect(outcome).toBe('done');
    expect(sentAt).toEqual([1000, 1100, 1200]);
  });

  it('records how late each send was against its plan (kills: lag not measured)', async () => {
    const c = clock();
    const results = await lib.runOpenLoop({
      items: [0, 1],
      rps: 1,
      now: c.now,
      // The harness wakes 7ms late every time.
      sleepUntil: async (until: number) => {
        c.sleepUntil(until + 7);
      },
      send: async () => ({ status: 200, latencyMs: 1 }),
    });
    expect(results.map((r: { lagMs: number }) => r.lagMs)).toEqual([7, 7]);
  });

  it('skips, never queues, an item due while maxInFlight are open (kills: cap ignored)', async () => {
    const c = clock();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let sends = 0;
    const run = lib.runOpenLoop({
      items: [0, 1, 2],
      rps: 10,
      maxInFlight: 1,
      now: c.now,
      sleepUntil: c.sleepUntil,
      send: async () => {
        sends++;
        await gate;
        return { status: 200, latencyMs: 1 };
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const results = await run;
    expect(sends).toBe(1);
    expect(results.map((r: { status: unknown }) => r.status)).toEqual([
      200,
      'skipped_overload',
      'skipped_overload',
    ]);
  });

  it('a send that throws is an error result, not a crashed run', async () => {
    const c = clock();
    const results = await lib.runOpenLoop({
      items: [0],
      rps: 1,
      now: c.now,
      sleepUntil: c.sleepUntil,
      send: async () => {
        throw new Error('ECONNRESET');
      },
    });
    expect(results[0]).toMatchObject({ status: 'error', error: 'ECONNRESET' });
  });
});

describe('armOrders', () => {
  it('rotates so each arm leads one round (kills: same order every round)', () => {
    expect(lib.armOrders(['go', 'node', 'next'], 3)).toEqual([
      ['go', 'node', 'next'],
      ['node', 'next', 'go'],
      ['next', 'go', 'node'],
    ]);
    expect(lib.armOrders(['a', 'b'], 3)).toEqual([
      ['a', 'b'],
      ['b', 'a'],
      ['a', 'b'],
    ]);
  });
});

describe('commonOkIndexes', () => {
  it('keeps only the requests every arm answered 200 (kills: any-arm instead of every-arm)', () => {
    expect(
      lib.commonOkIndexes({
        go: [{ status: 200 }, { status: 502 }, { status: 200 }, { status: 200 }],
        node: [{ status: 200 }, { status: 200 }, { status: 'error' }, { status: 200 }],
        next: [{ status: 200 }, { status: 200 }, { status: 200 }, { status: 200 }],
      })
    ).toEqual([0, 3]);
  });
});

describe('compareBodies (parity)', () => {
  const body = JSON.stringify({
    result: {
      data: {
        json: { nextCursor: 'c1', items: [{ postId: 11, user: { id: 3 }, images: [{ id: 8 }] }] },
        meta: { values: { 'items.0.createdAt': ['Date'] } },
      },
    },
  });

  it('positive control: the same bytes are equal both ways', () => {
    expect(lib.compareBodies(body, body)).toEqual({ bytesEqual: true, jsonEqual: true, diffs: [] });
  });

  it('key order differs: JSON-equal, not byte-equal (kills: bytes-only compare)', () => {
    const reordered = JSON.stringify({
      result: {
        data: {
          meta: { values: { 'items.0.createdAt': ['Date'] } },
          json: { items: [{ images: [{ id: 8 }], user: { id: 3 }, postId: 11 }], nextCursor: 'c1' },
        },
      },
    });
    expect(lib.compareBodies(body, reordered)).toEqual({
      bytesEqual: false,
      jsonEqual: true,
      diffs: [],
    });
  });

  it('negative control: a nested value change is reported at its path (kills: shallow compare)', () => {
    const changed = body.replace('"id":8', '"id":9');
    expect(changed).not.toBe(body);
    expect(lib.compareBodies(body, changed)).toEqual({
      bytesEqual: false,
      jsonEqual: false,
      diffs: [{ path: '$.result.data.json.items[0].images[0].id', a: 8, b: 9 }],
    });
  });

  it('a missing key, an extra array item and a type change are each reported', () => {
    const a = JSON.stringify({ x: 1, list: [1, 2], t: '5' });
    const b = JSON.stringify({ list: [1, 2, 3], t: 5 });
    expect(lib.compareBodies(a, b).diffs).toEqual([
      { path: '$.list.length', a: 2, b: 3 },
      { path: '$.t', a: '5', b: 5 },
      { path: '$.x', a: 1, b: undefined },
    ]);
  });

  it('a body that is not JSON is unequal at $', () => {
    expect(lib.compareBodies(body, 'Internal Server Error')).toEqual({
      bytesEqual: false,
      jsonEqual: false,
      diffs: [{ path: '$' }],
    });
  });

  it('stops at maxDiffs', () => {
    const a = JSON.stringify({ a: 1, b: 1, c: 1 });
    const b = JSON.stringify({ a: 2, b: 2, c: 2 });
    expect(lib.compareBodies(a, b, { maxDiffs: 2 }).diffs).toHaveLength(2);
  });
});

describe('cpuPerRequestMs', () => {
  it('subtracts the idle rate over the run (kills: no idle subtraction, wrong units)', () => {
    // Idle: 1.2 cpu-s over 120 s = 0.01 cores -> 6 cpu-s over the 600 s run.
    // (30 - 6) cpu-s / 1200 requests = 0.02 s = 20 ms.
    expect(
      lib.cpuPerRequestMs({
        busyCpuSeconds: 30,
        busySeconds: 600,
        idleCpuSeconds: 1.2,
        idleSeconds: 120,
        requests: 1200,
      })
    ).toBeCloseTo(20, 10);
  });

  it('is NaN without requests or windows', () => {
    const base = {
      busyCpuSeconds: 1,
      busySeconds: 1,
      idleCpuSeconds: 0,
      idleSeconds: 1,
      requests: 1,
    };
    expect(lib.cpuPerRequestMs({ ...base, requests: 0 })).toBeNaN();
    expect(lib.cpuPerRequestMs({ ...base, idleSeconds: 0 })).toBeNaN();
  });
});

describe('captureRowsFromTempoSearch', () => {
  const span = (id: string, url: string, startMs: number, durNs: number) => ({
    spanID: id,
    startTimeUnixNano: String(BigInt(startMs) * 1000000n),
    durationNanos: String(durNs),
    attributes: [
      { key: 'service.name', value: { stringValue: 'svc' } },
      { key: 'http.url', value: { stringValue: url } },
    ],
  });
  const input = '{"json":{"modelId":5001,"limit":3}}';
  const gallery = `http://green.example.test/api/trpc/image.getImagesAsPostsInfinite?input=${encodeURIComponent(
    input
  )}`;

  it('keeps time, host, raw input and duration, and nothing else', () => {
    const rows = lib.captureRowsFromTempoSearch({
      traces: [{ spanSets: [{ spans: [span('s1', gallery, 1795039195633, 20078130)] }] }],
    });
    expect(rows).toEqual([
      { t: 1795039195633, host: 'green.example.test', input, durMs: 20.07813 },
    ]);
  });

  it('drops other procedures, batches, credentials and duplicate spans', () => {
    const rows = lib.captureRowsFromTempoSearch({
      traces: [
        {
          spanSets: [
            { spans: [span('a', gallery, 1, 1e6)] },
            // the same span in a second span set
            { spans: [span('a', gallery, 1, 1e6)] },
          ],
        },
        { spanSet: { spans: [span('b', `${gallery}&token=secret`, 2, 1e6)] } },
        {
          spanSet: {
            spans: [
              span(
                'c',
                'http://green.example.test/api/trpc/image.getImagesAsPostsInfinite,image.get?batch=1',
                3,
                1e6
              ),
            ],
          },
        },
        {
          spanSet: {
            spans: [
              span('d', 'http://green.example.test/api/trpc/image.getInfinite?input=x', 4, 1e6),
            ],
          },
        },
      ],
    });
    expect(rows.map((r: { t: number }) => r.t)).toEqual([1]);
  });

  it('the replay path re-encodes the input exactly (round trip)', () => {
    const [row] = lib.captureRowsFromTempoSearch({
      traces: [{ spanSet: { spans: [span('s', gallery, 1, 1)] } }],
    });
    expect(lib.requestPath(row)).toBe(new URL(gallery).pathname + new URL(gallery).search);
    expect(lib.requestPath({ host: 'h', input: '' })).toBe(
      '/api/trpc/image.getImagesAsPostsInfinite'
    );
  });
});
