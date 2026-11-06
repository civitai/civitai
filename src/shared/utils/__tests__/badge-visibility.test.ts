import { describe, expect, it } from 'vitest';
import {
  isBadgeShownOnProfile,
  keepOwnedBadgeIds,
  withUnownedBadgeIds,
  splitProfileBadges,
} from '~/shared/utils/badge-visibility';

describe('isBadgeShownOnProfile', () => {
  it('shows a badge when the owner has set nothing', () => {
    expect(isBadgeShownOnProfile(null, 5)).toBe(true);
    expect(isBadgeShownOnProfile({}, 5)).toBe(true);
  });

  it('hides only the badges the owner listed', () => {
    expect(isBadgeShownOnProfile({ hiddenBadgeIds: [5] }, 5)).toBe(false);
    expect(isBadgeShownOnProfile({ hiddenBadgeIds: [5] }, 6)).toBe(true);
  });

  it('hides every badge, and a badge-less line, when badges are switched off', () => {
    expect(isBadgeShownOnProfile({ showBadges: false }, 5)).toBe(false);
    expect(isBadgeShownOnProfile({ showBadges: false }, null)).toBe(false);
  });

  it('shows a line with no badge behind it unless badges are switched off', () => {
    expect(isBadgeShownOnProfile({ hiddenBadgeIds: [5] }, null)).toBe(true);
  });
});

describe('splitProfileBadges', () => {
  const badge = (id: number, url: string) => ({ id, url });
  const getUrl = (b: { url: string }) => b.url;
  const ids = (badges: { id: number }[]) => badges.map((b) => b.id);

  it('keeps a highlighted badge that shares its image with a badge listed before it', () => {
    const badges = [badge(1812, 'bronze'), badge(1806, 'bronze'), badge(1813, 'bronze')];
    const { highlightedBadges, otherBadges } = splitProfileBadges(
      badges,
      { highlightedBadgeIds: [1806] },
      getUrl
    );
    expect(ids(highlightedBadges)).toEqual([1806]);
    expect(otherBadges).toEqual([]);
  });

  it('shows each image once among the other badges', () => {
    const badges = [badge(1, 'a'), badge(2, 'a'), badge(3, 'b')];
    expect(ids(splitProfileBadges(badges, {}, getUrl).otherBadges)).toEqual([1, 3]);
  });

  it('orders highlighted badges by pick order and drops hidden ones', () => {
    const badges = [badge(1, 'a'), badge(2, 'b'), badge(3, 'c')];
    const { highlightedBadges, otherBadges } = splitProfileBadges(
      badges,
      { highlightedBadgeIds: [3, 1, 2], hiddenBadgeIds: [2] },
      getUrl
    );
    expect(ids(highlightedBadges)).toEqual([3, 1]);
    expect(otherBadges).toEqual([]);
  });

  it('hides every badge sharing an image with a hidden one, highlighted or not', () => {
    const badges = [badge(1, 'a'), badge(2, 'a'), badge(3, 'b')];
    const { highlightedBadges, otherBadges } = splitProfileBadges(
      badges,
      { hiddenBadgeIds: [1], highlightedBadgeIds: [2] },
      getUrl
    );
    expect(highlightedBadges).toEqual([]);
    expect(ids(otherBadges)).toEqual([3]);
  });
});

describe('keepOwnedBadgeIds', () => {
  it('drops an unowned id from the middle and keeps the pick order', () => {
    expect(keepOwnedBadgeIds([7, 99, 9, 3], [3, 7, 9])).toEqual([7, 9, 3]);
  });

  it('treats a missing list as empty', () => {
    expect(keepOwnedBadgeIds(undefined, [1])).toEqual([]);
    expect(keepOwnedBadgeIds(null, [1])).toEqual([]);
  });
});

describe('withUnownedBadgeIds', () => {
  it('keeps a hidden id the user does not own right now behind the new picks', () => {
    // Saved hidden [98 (away), 3]; the user hides 5 and un-hides 3.
    expect(withUnownedBadgeIds([5], [98, 3], [3, 5, 7])).toEqual([5, 98]);
  });

  it('keeps nothing extra when every saved id is owned', () => {
    expect(withUnownedBadgeIds([3, 7], [7, 3], [3, 7])).toEqual([3, 7]);
  });

  it('treats a missing saved list as empty', () => {
    expect(withUnownedBadgeIds([1], undefined, [1])).toEqual([1]);
  });
});
