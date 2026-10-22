import { describe, expect, it } from 'vitest';
import { FLAG_CHIP_VALUES } from '../flagged-filters';

describe('FLAG_CHIP_VALUES', () => {
  it('offers the minor and real-person chips', () => {
    expect(FLAG_CHIP_VALUES).toEqual(['minor', 'poi']);
  });
});
