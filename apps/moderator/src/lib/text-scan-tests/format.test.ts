import { describe, expect, it } from 'vitest';
import { formatVersions } from './format';

describe('formatVersions', () => {
  it('keeps saved versions as key#id', () => {
    expect(formatVersions({ base: 1, scam: 2 })).toBe('base#1 scam#2');
  });

  it('shows the unsaved draft (id 0) as a draft', () => {
    expect(formatVersions({ base: 1, scam: 0 })).toBe('base#1 scam (draft)');
  });
});
