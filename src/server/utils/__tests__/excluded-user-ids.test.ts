import { describe, expect, it } from 'vitest';
import { boundExcludedUserIds, MAX_EXCLUDED_USER_IDS } from '../excluded-user-ids';

describe('boundExcludedUserIds', () => {
  it('returns the union of all three lists when under the cap', () => {
    const result = boundExcludedUserIds([1, 2], [3, 4], [5, 6]);
    expect(result).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.length).toBeLessThanOrEqual(MAX_EXCLUDED_USER_IDS);
  });

  it('de-duplicates ids that appear across lists (e.g. mutual blocks)', () => {
    // 10 is in both blockedByUsers and blockedUsers (a mutual block); 1 repeats within hidden.
    const result = boundExcludedUserIds([1, 1, 2], [10, 20], [10, 30]);
    expect(result).toEqual([1, 2, 10, 20, 30]);
    // Set semantics: every id appears exactly once.
    expect(new Set(result).size).toBe(result.length);
  });

  it('never exceeds MAX_EXCLUDED_USER_IDS', () => {
    const big = Array.from({ length: MAX_EXCLUDED_USER_IDS + 5000 }, (_, i) => i);
    const result = boundExcludedUserIds([], big, []);
    expect(result.length).toBe(MAX_EXCLUDED_USER_IDS);
  });

  it('drops the TAIL (viewer-own blockedUsers) first on overflow, never the involuntary lists', () => {
    // hiddenUsers + blockedByUsers together exactly fill the cap; blockedUsers is the overflow.
    const half = MAX_EXCLUDED_USER_IDS / 2;
    const hiddenUsers = Array.from({ length: half }, (_, i) => i); // ids [0 .. half-1]
    const blockedByUsers = Array.from({ length: half }, (_, i) => half + i); // ids [half .. MAX-1]
    const blockedUsers = [900000, 900001, 900002]; // the viewer's OWN mute list — distinct ids

    const result = boundExcludedUserIds(hiddenUsers, blockedByUsers, blockedUsers);
    const resultSet = new Set(result);

    expect(result.length).toBe(MAX_EXCLUDED_USER_IDS);
    // Every hidden + involuntary blocked-by id is retained.
    for (const id of hiddenUsers) expect(resultSet.has(id)).toBe(true);
    for (const id of blockedByUsers) expect(resultSet.has(id)).toBe(true);
    // The viewer's own block list is the part sacrificed on overflow.
    for (const id of blockedUsers) expect(resultSet.has(id)).toBe(false);
  });

  it('partially keeps blockedUsers only after hidden+blockedBy fit, still preferring involuntary lists', () => {
    // hidden+blockedBy = MAX-1, leaving exactly one slot for the first blockedUsers id.
    const hiddenUsers = Array.from({ length: MAX_EXCLUDED_USER_IDS - 1 }, (_, i) => i);
    const blockedByUsers: number[] = [];
    const blockedUsers = [800000, 800001, 800002];

    const result = boundExcludedUserIds(hiddenUsers, blockedByUsers, blockedUsers);
    const resultSet = new Set(result);

    expect(result.length).toBe(MAX_EXCLUDED_USER_IDS);
    for (const id of hiddenUsers) expect(resultSet.has(id)).toBe(true);
    // Exactly the first own-block id survives into the final slot; the rest are dropped.
    expect(resultSet.has(800000)).toBe(true);
    expect(resultSet.has(800001)).toBe(false);
    expect(resultSet.has(800002)).toBe(false);
  });

  it('handles empty inputs', () => {
    expect(boundExcludedUserIds([], [], [])).toEqual([]);
  });

  describe('isContentOwner (viewer looking at engagement on their OWN content)', () => {
    // A blocker (user 42) left a comment/review/downvote on the owner's content, then blocked
    // the owner. `42` therefore lands in the owner's blockedByUsers list.
    const blocker = 42;

    it('non-owner viewer still has the blocker excluded (anti-harassment stays)', () => {
      const result = boundExcludedUserIds([], [blocker], []);
      expect(result).toContain(blocker);
    });

    it("owner sees the blocker's engagement on their own content (blockedByUsers dropped)", () => {
      const result = boundExcludedUserIds([], [blocker], [], { isContentOwner: true });
      expect(result).not.toContain(blocker);
    });

    it('owner still excludes people on their OWN hidden/blocked lists', () => {
      // hidden(7) + own-block(8) must survive; only the involuntary blocked-by(42) is dropped.
      const result = boundExcludedUserIds([7], [blocker], [8], { isContentOwner: true });
      expect(result).toContain(7);
      expect(result).toContain(8);
      expect(result).not.toContain(blocker);
    });

    it('isContentOwner: false behaves identically to omitting the option', () => {
      expect(boundExcludedUserIds([1], [2], [3], { isContentOwner: false })).toEqual(
        boundExcludedUserIds([1], [2], [3])
      );
    });
  });
});
