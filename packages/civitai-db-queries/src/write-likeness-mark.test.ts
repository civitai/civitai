import { describe, expect, it, vi } from 'vitest';
import { writeLikenessMark } from './image-removal-confirmation.db';

// Both apps write the likeness mark through this; a lost mark keeps the image's appeal training copies.
describe('writeLikenessMark', () => {
  const fast = { backoffMs: 1 };

  it('writes once when the insert succeeds (control)', async () => {
    const insert = vi.fn(async () => undefined);
    const onGiveUp = vi.fn();

    expect(await writeLikenessMark(insert, onGiveUp, fast)).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('retries a failed insert, and the retry lands it', async () => {
    const insert = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);
    const onGiveUp = vi.fn();

    expect(await writeLikenessMark(insert, onGiveUp, fast)).toBe(true);
    expect(insert).toHaveBeenCalledTimes(2);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('gives up after every try failed, once, and never throws', async () => {
    const error = new Error('db down');
    const insert = vi.fn().mockRejectedValue(error);
    const onGiveUp = vi.fn();

    expect(await writeLikenessMark(insert, onGiveUp, fast)).toBe(false);
    expect(insert).toHaveBeenCalledTimes(3);
    expect(onGiveUp.mock.calls).toEqual([[error, 3]]);
  });
});
