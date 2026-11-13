import { describe, expect, it, vi } from 'vitest';
import { bounded } from '../bounded';

describe('bounded', () => {
  it('hands a failure to onError and still answers null', async () => {
    const onError = vi.fn();
    const err = new Error('db down');
    expect(await bounded(() => Promise.reject(err), 1_000, onError)).toBeNull();
    expect(onError).toHaveBeenCalledWith(err);
  });

  it('calls no onError for a value or a timeout', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const slow = bounded(() => new Promise<number>(() => {}), 50, onError);
    vi.advanceTimersByTime(50);
    expect(await slow).toBeNull();
    expect(await bounded(async () => 7, 50, onError)).toBe(7);
    expect(onError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
