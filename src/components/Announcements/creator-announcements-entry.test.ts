import { describe, expect, it } from 'vitest';

import {
  CREATOR_ANNOUNCEMENTS_URL,
  creatorAnnouncementsEntryVariant,
} from '~/components/Announcements/creator-announcements-entry';

const OWNER = 42;

const base = {
  featureEnabled: true,
  currentUserId: OWNER as number | null | undefined,
  profileUserId: OWNER,
  profileUserMuted: false,
  announcementCount: 0,
};

describe('creatorAnnouncementsEntryVariant', () => {
  it('shows the empty-state prompt to an owner with no announcements', () => {
    expect(creatorAnnouncementsEntryVariant(base)).toBe('empty');
  });

  it('shows the manage link to an owner who already has announcements', () => {
    expect(creatorAnnouncementsEntryVariant({ ...base, announcementCount: 2 })).toBe('manage');
  });

  // The point of this entry point is discovery, and the carousel renders nothing at zero — so the
  // empty state is the case that must not be dropped.
  it('is visible at a zero count, where the carousel itself renders nothing', () => {
    expect(creatorAnnouncementsEntryVariant({ ...base, announcementCount: 0 })).not.toBeNull();
  });

  describe('owner-only', () => {
    it('hides it from another signed-in user viewing the profile', () => {
      expect(creatorAnnouncementsEntryVariant({ ...base, currentUserId: OWNER + 1 })).toBeNull();
    });

    it('hides it from a signed-out visitor', () => {
      expect(creatorAnnouncementsEntryVariant({ ...base, currentUserId: undefined })).toBeNull();
      expect(creatorAnnouncementsEntryVariant({ ...base, currentUserId: null })).toBeNull();
    });
  });

  it('hides it behind the creatorAnnouncements flag', () => {
    expect(
      creatorAnnouncementsEntryVariant({ ...base, featureEnabled: false, announcementCount: 2 })
    ).toBeNull();
  });

  // Deliberate: a muted creator's announcements do not render on their profile, so pointing them at
  // the composer would send them to write something nobody can see. Do not drop this to simplify the
  // signature — the muted check is the reason it takes the profile user at all.
  it('hides it from a muted owner, who cannot have announcements rendered', () => {
    expect(
      creatorAnnouncementsEntryVariant({ ...base, profileUserMuted: true, announcementCount: 2 })
    ).toBeNull();
  });

  it('deep-links to the announcements page, not the Creator Studio root', () => {
    expect(CREATOR_ANNOUNCEMENTS_URL).toBe('https://creator-studio.civitai.com/announcements');
  });
});
