import { describe, expect, it } from 'vitest';
import { countOf, formatVersions } from './format';

describe('countOf', () => {
  it('pluralizes except for exactly one', () => {
    expect(countOf(0, 'case')).toBe('0 cases');
    expect(countOf(1, 'case')).toBe('1 case');
    expect(countOf(2, 'case')).toBe('2 cases');
  });
});

describe('formatVersions', () => {
  it('keeps saved versions as key#id', () => {
    expect(formatVersions({ base: 1, scam: 2 })).toBe('base#1 scam#2');
  });

  it('shows the unsaved draft (id 0) as a draft', () => {
    expect(formatVersions({ base: 1, scam: 0 })).toBe('base#1 scam (draft)');
  });
});
