import { describe, expect, it } from 'vitest';
import { shouldShowProfileMessage } from '~/components/Profile/profile.utils';

/**
 * 26,403 profile banners migrate into profile-only announcements, and the `message` columns
 * stay populated until that migration retires them. The rule this pins is the ordering
 * safety: a creator without an announcement keeps their banner, a creator with one does not
 * get both.
 */
describe('shouldShowProfileMessage', () => {
  it('shows the banner for a creator who has no announcement yet', () => {
    expect(
      shouldShowProfileMessage({ message: 'follow me', userMuted: false, announcementCount: 0 })
    ).toBe(true);
  });

  it('hides the banner once a live announcement supersedes it', () => {
    expect(
      shouldShowProfileMessage({ message: 'follow me', userMuted: false, announcementCount: 1 })
    ).toBe(false);
  });

  it('hides the banner for a muted user regardless of announcements', () => {
    expect(
      shouldShowProfileMessage({ message: 'follow me', userMuted: true, announcementCount: 0 })
    ).toBe(false);
  });

  it('shows nothing when there is no message to show', () => {
    expect(shouldShowProfileMessage({ message: '', userMuted: false, announcementCount: 0 })).toBe(
      false
    );
    expect(
      shouldShowProfileMessage({ message: null, userMuted: false, announcementCount: 0 })
    ).toBe(false);
  });
});
