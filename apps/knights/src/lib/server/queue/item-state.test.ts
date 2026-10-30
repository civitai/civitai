import { describe, expect, it } from 'vitest';
import { isFinalItem } from './item-state';

describe('isFinalItem', () => {
  it('counts a closed item and a written-back resolution, not an unwritten one', () => {
    expect(isFinalItem({ status: 'Closed', appliedAt: null })).toBe(true);
    expect(isFinalItem({ status: 'Resolved', appliedAt: new Date() })).toBe(true);
    expect(isFinalItem({ status: 'Resolved', appliedAt: null })).toBe(false);
    expect(isFinalItem({ status: 'Open', appliedAt: null })).toBe(false);
  });

  it('counts a consensus only on a yes/no question, which has nothing to write back', () => {
    expect(isFinalItem({ status: 'Consensus', appliedAt: null, audience: 'players' })).toBe(true);
    expect(isFinalItem({ status: 'Consensus', appliedAt: null, audience: null })).toBe(false);
    expect(isFinalItem({ status: 'Consensus', appliedAt: null })).toBe(false);
  });
});
