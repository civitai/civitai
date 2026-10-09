import { describe, expect, it } from 'vitest';
import { isBadgeShownOnProfile } from '~/shared/utils/badge-visibility';

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
