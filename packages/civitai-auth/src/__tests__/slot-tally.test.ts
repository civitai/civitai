import { describe, expect, it, vi } from 'vitest';
import { createSlotTally } from '../slot-tally';

describe('createSlotTally', () => {
  it('writes the counts gathered over each interval once, on the first read past it', () => {
    let t = 0;
    const flush = vi.fn();
    const record = createSlotTally(flush, { intervalMs: 1000, now: () => t });
    record('shared');
    record('host');
    record('shared');
    expect(flush).not.toHaveBeenCalled();
    t = 1000;
    record('host');
    expect(flush.mock.calls).toEqual([[{ host: 2, shared: 2 }]]);
    t = 1500;
    record('shared');
    t = 2000;
    record('shared');
    expect(flush.mock.calls[1]).toEqual([{ host: 0, shared: 2 }]);
  });
});
