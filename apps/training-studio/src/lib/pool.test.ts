import { describe, expect, it, vi } from 'vitest';
import { abortableDelay } from './pool';

describe('abortableDelay', () => {
  it('rejects at once for a signal that is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableDelay(50, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('leaves no abort listener behind once the delay elapses', async () => {
    vi.useFakeTimers();
    try {
      const signal = new AbortController().signal;
      const add = vi.spyOn(signal, 'addEventListener');
      const remove = vi.spyOn(signal, 'removeEventListener');
      const done = abortableDelay(10, signal);
      await vi.advanceTimersByTimeAsync(10);
      await done;
      expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
    } finally {
      vi.useRealTimers();
    }
  });
});
