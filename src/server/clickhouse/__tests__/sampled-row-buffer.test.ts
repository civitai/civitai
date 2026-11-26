import { describe, expect, it, vi } from 'vitest';
import {
  MAX_BUFFERED_ROWS,
  createSampledRowBuffer,
  hashToUnit,
  type CaptureConfig,
} from '~/server/clickhouse/sampled-row-buffer';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);
const ON: CaptureConfig = { sampleRate: 1, until: Number.POSITIVE_INFINITY };

function harness(config: CaptureConfig, { random = 0.5, insert = async () => undefined } = {}) {
  const inserted: number[][] = [];
  const counts: Record<string, number> = {};
  const counter = {
    inc: ({ outcome }: { outcome: string }) => (counts[outcome] = (counts[outcome] ?? 0) + 1),
  };
  const buffer = createSampledRowBuffer<number>({
    table: 'testRows',
    getConfig: async () => config,
    insert: vi.fn(async (rows: number[]) => {
      inserted.push(rows);
      await insert();
    }),
    counters: { batches: counter, rows: counter },
    now: () => T0,
    random: () => random,
    flushIntervalMs: 60_000,
  });
  let n = 0;
  const push = (opts?: { unsampled?: boolean; sampleKey?: string }) => buffer.push(() => ++n, opts);
  return { buffer, inserted, counts, push };
}

describe('createSampledRowBuffer', () => {
  it('writes nothing once `until` has passed, even for an unsampled row', async () => {
    const { buffer, push } = harness({ sampleRate: 1, until: T0 - 1 });
    await push();
    await push({ unsampled: true });
    expect(buffer.pending).toBe(0);
  });

  it('keeps a row only when the roll falls under the rate', async () => {
    const under = harness({ ...ON, sampleRate: 0.6 }, { random: 0.5 });
    const over = harness({ ...ON, sampleRate: 0.5 }, { random: 0.5 });
    await under.push();
    await over.push();
    expect([under.buffer.pending, over.buffer.pending]).toEqual([1, 0]);
  });

  it('an unsampled row skips the roll but not a switched-off capture', async () => {
    const low = harness({ ...ON, sampleRate: 0.01 }, { random: 0.99 });
    const off = harness({ ...ON, sampleRate: 0 }, { random: 0 });
    await low.push({ unsampled: true });
    await off.push({ unsampled: true });
    expect([low.buffer.pending, off.buffer.pending]).toEqual([1, 0]);
  });

  it('a sampleKey keeps or drops every row of that key together, at the rate, ignoring the roll', async () => {
    const keys = Array.from({ length: 2000 }, (_, i) => `session-${i}`);
    // The roll would keep everything; the key's hash alone decides.
    const { buffer, inserted, push } = harness({ ...ON, sampleRate: 0.1 }, { random: 0 });
    for (const sampleKey of keys) {
      await push({ sampleKey });
      await push({ sampleKey });
    }
    const keptKeys = keys.filter((k) => hashToUnit(k) < 0.1).length;
    await buffer.flush();
    expect(inserted.flat().length).toBe(keptKeys * 2);
    expect(keptKeys / keys.length).toBeGreaterThan(0.07);
    expect(keptKeys / keys.length).toBeLessThan(0.13);
  });

  it(`sheds rows past ${MAX_BUFFERED_ROWS} while an insert is in flight, with one insert at a time`, async () => {
    let release!: (v: undefined) => void;
    const stuck = new Promise<undefined>((r) => (release = r));
    const { buffer, inserted, counts, push } = harness(ON, { insert: () => stuck });

    // The 200th row starts an insert, which stays in flight.
    for (let i = 0; i < 200; i++) await push();
    for (let i = 0; i < MAX_BUFFERED_ROWS + 5; i++) await push();
    expect(inserted).toHaveLength(1);
    expect(buffer.pending).toBe(MAX_BUFFERED_ROWS);
    expect(buffer.dropped).toBe(5);
    expect(counts.dropped).toBe(5);

    // Once the first insert settles, the rest goes in one more.
    release(undefined);
    await new Promise((r) => setTimeout(r, 0));
    await buffer.flush();
    expect(inserted.map((b) => b.length)).toEqual([200, MAX_BUFFERED_ROWS]);
    expect(counts.ok).toBe(2);
  });
});
