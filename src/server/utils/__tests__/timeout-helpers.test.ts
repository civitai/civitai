import { describe, it, expect, vi } from 'vitest';
import { withTimeoutFallback } from '../timeout-helpers';

// A promise that never settles — simulates a wedged/parked async call (e.g. a
// ClickHouse read that hangs until the client's own 30s default).
const never = () => new Promise<never>(() => {});

describe('withTimeoutFallback', () => {
  it('returns the real value when the promise resolves before the timeout', async () => {
    const result = await withTimeoutFallback(Promise.resolve('real'), 1000, 'fallback');
    expect(result).toBe('real');
  });

  it('returns the fallback and fires onTimeout when the promise hangs', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn();
      const p = withTimeoutFallback(never(), 2500, 'fallback', onTimeout);
      // The work never resolves; only the timer can settle the race.
      await vi.advanceTimersByTimeAsync(2500);
      await expect(p).resolves.toBe('fallback');
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not throw / no unhandled rejection when the underlying promise rejects AFTER the timeout', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      // Rejects 5s in, but the timeout fires at 1s → the race already resolved
      // with the fallback; the later rejection must be swallowed.
      let rejectLate!: (e: unknown) => void;
      const late = new Promise<string>((_, reject) => {
        rejectLate = reject;
      });
      const p = withTimeoutFallback(late, 1000, 'fallback');
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).resolves.toBe('fallback');

      rejectLate(new Error('socket hang up'));
      // Let the swallowing .catch + any microtasks flush.
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
      vi.useRealTimers();
    }
  });

  it('still resolves with the fallback when onTimeout throws synchronously', async () => {
    vi.useFakeTimers();
    try {
      const onTimeout = vi.fn(() => {
        throw new Error('onTimeout blew up');
      });
      const p = withTimeoutFallback(never(), 2500, 'fallback', onTimeout);
      await vi.advanceTimersByTimeAsync(2500);
      // The throwing callback must not strand the caller nor propagate.
      await expect(p).resolves.toBe('fallback');
      expect(onTimeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the promise straight through when ms <= 0 (guard disabled)', async () => {
    const result = await withTimeoutFallback(Promise.resolve('real'), 0, 'fallback');
    expect(result).toBe('real');
  });
});
