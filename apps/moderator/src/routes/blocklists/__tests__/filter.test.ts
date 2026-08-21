import { describe, expect, it } from 'vitest';
import { visibleBlocklistItems } from '../filter';

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
  // The lists do not all enforce in the same direction: UsernamePartial and MessagePattern
  // enforce `input.includes(entry)`, so the entry is a substring of what the moderator types.
  it('finds the short entry that blocks a long value the moderator pastes', () => {
    const list = ['scammer', 'unrelated'];
    expect(visibleBlocklistItems(list, 'xXscammerXx', 10).matches).toEqual(['scammer']);
  });

  it('still finds a long entry from a short needle', () => {
    const list = ['scammer', 'unrelated'];
    expect(visibleBlocklistItems(list, 'scam', 10).matches).toEqual(['scammer']);
  });

  it('does not match an entry that is neither a substring nor a superstring', () => {
    expect(visibleBlocklistItems(['scammer'], 'legitimate', 10).matches).toEqual([]);
  });

  it('matches bidirectionally without regard to case', () => {
    expect(visibleBlocklistItems(['Scammer'], 'xXSCAMMERXx', 10).matches).toEqual(['Scammer']);
  });
});
