import { describe, expect, it } from 'vitest';
import { flagChipValues } from '../flagged-filters';

describe('flagChipValues', () => {
  it('shows no flag chips when no flag filter is set', () => {
    expect(flagChipValues('all')).toEqual([]);
  });
  it('keeps the chip of a flag filter an older link still sets, so it can be switched off', () => {
    expect(flagChipValues('minor')).toEqual(['minor']);
    expect(flagChipValues('poi')).toEqual(['poi']);
  });
});
