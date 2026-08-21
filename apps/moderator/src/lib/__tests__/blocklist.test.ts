import { describe, expect, it } from 'vitest';
import { visibleBlocklistItems } from '../blocklist';

// Alphabetical, so `zzz-late.example` sorts past any cap applied before the filter.
const bigList = [
  ...Array.from({ length: 300 }, (_, i) => `aaa-${String(i).padStart(3, '0')}.example`),
  'zzz-late.example',
];

describe('visibleBlocklistItems', () => {
  it('returns everything up to the cap when no filter is set', () => {
    const { matches, visible } = visibleBlocklistItems(bigList, '', 200);
    expect(matches).toHaveLength(301);
    expect(visible).toHaveLength(200);
  });

  it('searches the WHOLE list, not just the first `limit` entries', () => {
    // Capping before filtering would drop this entry — it sits at index 300 of 301.
    const { matches, visible } = visibleBlocklistItems(bigList, 'zzz-late', 200);
    expect(matches).toEqual(['zzz-late.example']);
    expect(visible).toEqual(['zzz-late.example']);
  });

  it('still caps a filter that matches more than the limit', () => {
    const { matches, visible } = visibleBlocklistItems(bigList, 'aaa-', 200);
    expect(matches).toHaveLength(300);
    expect(visible).toHaveLength(200);
  });

  it('matches case-insensitively in both directions', () => {
    const list = ['MixedCase.example', 'lower.example'];
    expect(visibleBlocklistItems(list, 'mixedcase', 10).matches).toEqual(['MixedCase.example']);
    expect(visibleBlocklistItems(list, 'LOWER', 10).matches).toEqual(['lower.example']);
  });

  it('ignores surrounding whitespace in the filter', () => {
    expect(visibleBlocklistItems(['spam.example'], '  spam  ', 10).matches).toEqual([
      'spam.example',
    ]);
  });

  it('treats a whitespace-only filter as no filter', () => {
    expect(visibleBlocklistItems(['a.example', 'b.example'], '   ', 10).matches).toHaveLength(2);
  });
});
