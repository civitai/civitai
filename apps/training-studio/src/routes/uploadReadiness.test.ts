import { describe, expect, it, vi } from 'vitest';
import type { TrainingRunPayload } from '$lib/backend';
import type { BlobReadiness, ReadinessCheck, ReadinessProbe } from '$lib/upload-readiness';
import {
  holdsStart,
  readinessMessage,
  READINESS_FAILED_READS,
  READINESS_MAX_MS,
  READINESS_POLL_MS,
  watchReadiness,
  type ReadinessView,
} from './uploadReadiness';

const RUN = { meta: { name: 'x' } } as unknown as TrainingRunPayload;

/** Drives watchReadiness to its last view. `answer` gives each read's state per blob; `checks` the whatifs. */
async function drive(
  ids: string[],
  answer: (id: string, read: number) => BlobReadiness,
  checks: ReadinessCheck[] = [{ enabled: true, ready: true }],
  { probeOff = false, buildRun = true } = {}
) {
  const reads = new Map<string, number>();
  const probed: string[][] = [];
  const views: ReadinessView[] = [];
  let clock = 0;
  const probe = vi.fn(async (blobIds: string[]): Promise<ReadinessProbe> => {
    probed.push(blobIds);
    if (probeOff) return { enabled: false };
    const states: Record<string, BlobReadiness> = {};
    for (const id of blobIds) {
      const n = (reads.get(id) ?? 0) + 1;
      reads.set(id, n);
      states[id] = answer(id, n);
    }
    return { enabled: true, states };
  });
  const check = vi.fn(async () => checks.shift() ?? { enabled: true as const, ready: true });
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  watchReadiness(ids, {
    probe,
    check,
    buildRun: () => (buildRun ? RUN : undefined),
    onView: (v) => {
      views.push(v);
      if (v.kind !== 'checking') done();
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  await finished;
  return { probed, views, last: views.at(-1)!, check, clock };
}

describe('watchReadiness', () => {
  it('holds Start from the first moment, before any file is read', () => {
    const views: ReadinessView[] = [];
    const stop = watchReadiness(['a'], {
      probe: () => new Promise(() => {}),
      check: async () => ({ enabled: true, ready: true }),
      buildRun: () => RUN,
      onView: (v) => views.push(v),
    });
    expect(views).toEqual([{ kind: 'checking', ready: 0, total: 1 }]);
    expect(holdsStart(views[0]!)).toBe(true);
    stop();
  });

  it('waits for a file still processing, then releases Start', async () => {
    const { last, check } = await drive(['a', 'b'], (id, n) =>
      id === 'b' && n < 3 ? 'processing' : 'ready'
    );
    expect(last).toEqual({ kind: 'ready' });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('reads only the files not yet ready after the first pass', async () => {
    const { probed } = await drive(['a', 'b', 'c'], (id, n) =>
      id === 'c' && n < 3 ? 'processing' : 'ready'
    );
    expect(probed[0]).toEqual(['a', 'b', 'c']);
    expect(probed.slice(1)).toEqual([['c'], ['c']]);
  });

  it('asks the orchestrator once when every file reads ready', async () => {
    const { check, last } = await drive(['a', 'b'], () => 'ready');
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith(RUN);
    expect(last).toEqual({ kind: 'ready' });
  });

  it('re-reads every file once after the orchestrator refuses a dataset that read ready', async () => {
    // An older file reads ready until the refusal starts its processing, which the next read shows.
    const { probed, check, last, views } = await drive(
      ['a', 'old'],
      (id, n) => (id === 'old' && n === 2 ? 'processing' : 'ready'),
      [{ enabled: true, ready: false }]
    );
    expect(probed).toEqual([['a', 'old'], ['a', 'old'], ['old']]);
    expect(check).toHaveBeenCalledTimes(2);
    expect(last).toEqual({ kind: 'ready' });
    // Not "2 of 2 ready" while every file is read again.
    const afterRefusal = views.slice(views.findIndex((v, i) => i > 0 && v.kind === 'checking'));
    expect(afterRefusal[0]).toEqual({ kind: 'checking', ready: 0, total: 2 });
  });

  it('shows the files that cannot be used, and holds Start', async () => {
    const { last } = await drive(['a', 'b'], (id) => (id === 'b' ? 'unusable' : 'ready'));
    expect(last).toEqual({ kind: 'unusable', blobIds: ['b'] });
    expect(holdsStart(last)).toBe(true);
  });

  it(`reads a failed file at most ${READINESS_FAILED_READS} times, then asks to check again`, async () => {
    const { probed, last } = await drive(['a', 'f'], (id) => (id === 'f' ? 'failed' : 'ready'));
    expect(probed.filter((p) => p.includes('f'))).toHaveLength(READINESS_FAILED_READS);
    expect(last).toEqual({ kind: 'slow' });
  });

  it('stops reading a failed file while it waits on another', async () => {
    const { probed } = await drive(['p', 'f'], (id, n) =>
      id === 'f' ? 'failed' : n < 6 ? 'processing' : 'ready'
    );
    expect(probed.filter((p) => p.includes('f'))).toHaveLength(READINESS_FAILED_READS);
    expect(probed.filter((p) => p.includes('p'))).toHaveLength(6);
  });

  it('gives up waiting after the poll cap and asks to check again', async () => {
    const { last, clock, probed } = await drive(['a'], () => 'processing');
    expect(last).toEqual({ kind: 'slow' });
    expect(clock).toBeGreaterThanOrEqual(READINESS_MAX_MS);
    expect(probed.length).toBeLessThanOrEqual(READINESS_MAX_MS / READINESS_POLL_MS + 1);
  });

  it('stops holding Start when the server switches the wait off', async () => {
    const { last } = await drive(['a'], () => 'processing', [], { probeOff: true });
    expect(last).toEqual({ kind: 'off' });
    expect(holdsStart(last)).toBe(false);
  });

  it('releases Start when the whatif says anything but not ready', async () => {
    const { last } = await drive(['a'], () => 'ready', [{ enabled: true, ready: null }]);
    expect(last).toEqual({ kind: 'ready' });
  });

  it('stops holding Start on any error', async () => {
    const views: ReadinessView[] = [];
    await new Promise<void>((done) =>
      watchReadiness(['a'], {
        probe: async () => {
          throw new Error('down');
        },
        check: async () => ({ enabled: true, ready: true }),
        buildRun: () => RUN,
        onView: (v) => {
          views.push(v);
          if (v.kind === 'off') done();
        },
      })
    );
    expect(views.at(-1)).toEqual({ kind: 'off' });
  });
});

describe('readinessMessage', () => {
  it('counts the pairs an edit dataset loses, not the files', () => {
    // Both files of one pair: Remove takes out one pair.
    const view: ReadinessView = { kind: 'unusable', blobIds: ['before-1', 'after-1'] };
    expect(readinessMessage(view, { unusableCount: 1, noun: 'pair' })).toBe(
      "1 pair can't be used for training. Remove it to continue."
    );
    expect(readinessMessage({ kind: 'unusable', blobIds: ['a', 'b'] })).toBe(
      "2 files can't be used for training. Remove them to continue."
    );
  });
});
