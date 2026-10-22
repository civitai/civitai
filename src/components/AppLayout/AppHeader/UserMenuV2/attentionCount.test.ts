import { describe, expect, it } from 'vitest';
import { attentionCount, type AttentionCounts } from './attentionCount';

const counts: AttentionCounts = {
  placements: 2,
  collections: 49,
  inventory: undefined,
  prizes: 1,
};

describe('attentionCount', () => {
  it('adds up every waiting count when none is muted', () => {
    expect(attentionCount(counts, [])).toBe(52);
  });

  it('leaves out a muted count', () => {
    expect(attentionCount(counts, ['collections'])).toBe(3);
    expect(attentionCount(counts, ['collections', 'prizes', 'placements'])).toBe(0);
  });

  it('ignores a mute on a count that is not there', () => {
    expect(attentionCount(counts, ['inventory'])).toBe(52);
  });
});
