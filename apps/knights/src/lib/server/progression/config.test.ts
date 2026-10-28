import { describe, expect, it } from 'vitest';
import { goldForRank } from './config';

describe('goldForRank', () => {
  it('pays moderators and Acolytes nothing', () => {
    expect(goldForRank('Inquisitor')).toBe(0);
    expect(goldForRank('Acolyte')).toBe(0);
  });

  it('applies the rank multiplier and the below-bar factor', () => {
    expect(goldForRank('Knight')).toBe(100);
    expect(goldForRank('Templar')).toBe(125);
    expect(goldForRank('Templar', true)).toBe(63);
  });
});
