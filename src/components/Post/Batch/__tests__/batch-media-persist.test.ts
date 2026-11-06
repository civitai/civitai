import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPersistQueue } from '~/components/Post/Batch/useBatchMediaPersist';

describe('createPersistQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends a burst as chunks of the configured size once the window closes', async () => {
    const send = vi.fn(async () => undefined);
    const queue = createPersistQueue<number>({ chunkSize: 10, delayMs: 300, send });
    for (let i = 0; i < 25; i++) {
      queue.add(i);
      vi.advanceTimersByTime(100);
    }
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(send.mock.calls.map(([items]) => (items as number[]).length)).toEqual([10, 10, 5]);
    expect((send.mock.calls[2][0] as number[])[4]).toBe(24);
  });

  it('starts a new batch for items added after the window closed', () => {
    const send = vi.fn(async () => undefined);
    const queue = createPersistQueue<string>({ chunkSize: 10, delayMs: 300, send });
    queue.add('a');
    vi.advanceTimersByTime(300);
    queue.add('b');
    vi.advanceTimersByTime(300);
    expect(send.mock.calls.map(([items]) => items)).toEqual([['a'], ['b']]);
  });

  it('keeps sending the other chunks when one rejects', async () => {
    const send = vi.fn(async (items: number[]) => {
      if (items[0] === 0) throw new Error('nope');
    });
    const queue = createPersistQueue<number>({ chunkSize: 2, delayMs: 10, send });
    [0, 1, 2, 3].forEach((n) => queue.add(n));
    vi.advanceTimersByTime(10);
    await vi.runAllTimersAsync();
    expect(send.mock.calls.map(([items]) => items)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it('sends nothing after dispose', () => {
    const send = vi.fn(async () => undefined);
    const queue = createPersistQueue<number>({ chunkSize: 10, delayMs: 300, send });
    queue.add(1);
    queue.dispose();
    vi.advanceTimersByTime(300);
    expect(send).not.toHaveBeenCalled();
  });
});
