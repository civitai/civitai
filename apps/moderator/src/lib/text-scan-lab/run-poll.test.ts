import { describe, expect, it, vi } from 'vitest';
import { LOST_TRACK, pollRuns, progressText, type RunProgress } from './run-poll';

const p = (runId: number, status: RunProgress['status'], done = 0): RunProgress => ({
  runId,
  status,
  done,
  total: 10,
});

describe('pollRuns', () => {
  it('reads every run each round until none is running, reporting each round', async () => {
    const states = new Map<number, RunProgress[]>([
      [1, [p(1, 'running', 2), p(1, 'done', 10)]],
      [2, [p(2, 'running', 1), p(2, 'running', 6), p(2, 'failed', 10)]],
    ]);
    const read = vi.fn(async (id: number) => {
      const queue = states.get(id)!;
      return queue.length > 1 ? queue.shift()! : queue[0];
    });
    const onProgress = vi.fn();

    const last = await pollRuns({ runIds: [1, 2], read, onProgress, intervalMs: 0 });

    expect(last).toEqual([p(1, 'done', 10), p(2, 'failed', 10)]);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress.mock.calls[0][0]).toEqual([p(1, 'running', 2), p(2, 'running', 1)]);
  });

  it('treats an interrupted run as no longer running', async () => {
    const last = await pollRuns({
      runIds: [1],
      read: async () => p(1, 'interrupted', 3),
      onProgress: () => {},
      intervalMs: 0,
    });
    expect(last).toEqual([p(1, 'interrupted', 3)]);
  });

  it('tries a failed read again, and gives up after five in a row', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(p(1, 'done', 10));
    expect(await pollRuns({ runIds: [1], read, onProgress: () => {}, intervalMs: 0 })).toEqual([
      p(1, 'done', 10),
    ]);

    const down = vi.fn().mockRejectedValue(new Error('offline'));
    await expect(
      pollRuns({ runIds: [1], read: down, onProgress: () => {}, intervalMs: 0 })
    ).rejects.toThrow(LOST_TRACK);
    expect(down).toHaveBeenCalledTimes(5);
  });

  it('stops quietly when aborted', async () => {
    const controller = new AbortController();
    const read = vi.fn(async () => {
      controller.abort();
      return p(1, 'running');
    });
    const onProgress = vi.fn();
    expect(
      await pollRuns({ runIds: [1], read, onProgress, intervalMs: 0, signal: controller.signal })
    ).toBeNull();
    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe('progressText', () => {
  it('names each run', () => {
    expect(
      progressText(
        [p(1, 'running', 120), { ...p(2, 'running', 80), total: null }],
        ['Current', 'With my changes']
      )
    ).toBe('Current 120 of 10 · With my changes 80 scanned');
  });
});
