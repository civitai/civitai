import { describe, expect, it } from 'vitest';
import {
  leadRefs,
  needsReviewBranches,
  needsReviewChipCounts,
  needsReviewCountKey,
  needsReviewSourceChips,
  needsReviewSources,
  needsReviewTotal,
} from '../needs-review';

const both = { detections: true, matches: true };
const detectionsOnly = { detections: true, matches: false };
const matchesOnly = { detections: false, matches: true };

describe('needsReviewSources', () => {
  it('reads each kind from its own permission', () => {
    expect(needsReviewSources({})).toEqual({ detections: false, matches: false });
    expect(needsReviewSources({ 'modelFlags.fileMatches.decide': true })).toEqual(matchesOnly);
    expect(
      needsReviewSources({
        'modelFlags.detections.decide': true,
        'modelFlags.fileMatches.decide': true,
      })
    ).toEqual(both);
  });
});

describe('needsReviewBranches', () => {
  const all = { source: 'all', flag: 'all' } as const;

  it('runs only the kinds the viewer holds, whatever the filter asks for', () => {
    expect(needsReviewBranches(detectionsOnly, all)).toEqual(detectionsOnly);
    expect(needsReviewBranches(matchesOnly, { source: 'text-scan', flag: 'all' })).toEqual({
      detections: false,
      matches: false,
    });
  });

  it('narrows to one kind by source', () => {
    expect(needsReviewBranches(both, { source: 'hash', flag: 'all' })).toEqual(matchesOnly);
    expect(needsReviewBranches(both, { source: 'text-scan', flag: 'all' })).toEqual(detectionsOnly);
  });

  it('drops file matches under a real-person filter: they are minor leads', () => {
    expect(needsReviewBranches(both, { source: 'all', flag: 'poi' })).toEqual(detectionsOnly);
    expect(needsReviewBranches(both, { source: 'all', flag: 'minor' })).toEqual(both);
  });
});

describe('needsReviewSourceChips', () => {
  it('offers source chips only when the viewer holds both kinds', () => {
    expect(needsReviewSourceChips(both)).toEqual(['all', 'text-scan', 'hash']);
    expect(needsReviewSourceChips(detectionsOnly)).toEqual([]);
  });
});

describe('needsReviewCountKey', () => {
  it('reads the badge for the kinds the viewer holds, and none when they hold neither', () => {
    expect(needsReviewCountKey(both)).toBe('modelFlagsNeedsReview');
    expect(needsReviewCountKey(detectionsOnly)).toBe('modelFlagsNeedsReviewDetections');
    expect(needsReviewCountKey(matchesOnly)).toBe('modelFlagsNeedsReviewMatches');
    expect(needsReviewCountKey({ detections: false, matches: false })).toBeUndefined();
  });
});

describe('needsReviewTotal', () => {
  const counts = { detections: 4, matches: 10, overlap: 1 };

  it('counts a model with both a detection and a file match once', () => {
    expect(needsReviewTotal(both, counts)).toBe(13);
  });

  it('counts only the kinds held', () => {
    expect(needsReviewTotal(detectionsOnly, counts)).toBe(4);
    expect(needsReviewTotal(matchesOnly, { ...counts, overlap: null })).toBe(10);
  });

  it('is unknown while a part of the sum is', () => {
    expect(needsReviewTotal(both, { ...counts, matches: null })).toBeNull();
    expect(needsReviewTotal(detectionsOnly, { ...counts, matches: null })).toBe(4);
  });
});

describe('leadRefs', () => {
  const held = { label: 'minor' as const, source: 'redetected' as const, textHash: 'h', extra: 1 };

  it('rules held detections first, then the file match as a minor lead', () => {
    expect(leadRefs({ flags: [held], match: { hash: 'aa' } })).toEqual([
      { label: 'minor', source: 'redetected', textHash: 'h' },
      { label: 'minor', source: 'file-match', textHash: null },
    ]);
    expect(leadRefs({ flags: [], match: null })).toEqual([]);
  });
});

describe('needsReviewChipCounts', () => {
  it('counts each source chip, All counting a model with both leads once', () => {
    expect(needsReviewChipCounts(both, { detections: 4, matches: 10, overlap: 1 })).toEqual({
      all: 13,
      'text-scan': 4,
      hash: 10,
    });
  });
  it('drops a count whose part is unknown, and All with it', () => {
    expect(needsReviewChipCounts(both, { detections: 4, matches: null, overlap: null })).toEqual({
      'text-scan': 4,
    });
  });
  it('offers no counts when the chips are not shown', () => {
    expect(
      needsReviewChipCounts(
        { detections: true, matches: false },
        { detections: 4, matches: 10, overlap: 1 }
      )
    ).toEqual({});
  });
});
