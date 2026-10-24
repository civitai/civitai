import { describe, expect, it } from 'vitest';
import { parseSidebarCounts } from '../sidebar-counts-response';

describe('parseSidebarCounts', () => {
  it('separates the unavailable keys from the counts', () => {
    expect(
      parseSidebarCounts({ modelFlagsAuto: 4, unavailable: ['modelFlagsNeedsReview'] })
    ).toEqual({ counts: { modelFlagsAuto: 4 }, unavailable: ['modelFlagsNeedsReview'] });
  });

  it('reads a response from a server that sends no unavailable list', () => {
    expect(parseSidebarCounts({ modelFlagsAuto: 4 })).toEqual({
      counts: { modelFlagsAuto: 4 },
      unavailable: [],
    });
  });
});
