import { describe, expect, it } from 'vitest';

import {
  CREATOR_ANNOUNCEMENTS_URL,
  creatorAnnouncementsEntryVariant,
} from '~/components/Announcements/creator-announcements-entry';
import { CREATOR_STUDIO_URL } from '~/shared/constants/creator-studio.constants';

const OWNER = 42;

const base = {
  featureEnabled: true,
  currentUserId: OWNER as number | null | undefined,
  profileUserId: OWNER,
  profileUserMuted: false,
  announcementCount: 0,
  announcementsLoading: false,
  announcementsErrored: false,
};

describe('creatorAnnouncementsEntryVariant', () => {
  // The point of this entry point is discovery, and the carousel renders nothing at a zero count —
  // so the empty case is the one that must keep showing something. This test is what protects it.
  it('shows the empty-state prompt to an owner with no announcements', () => {
    expect(creatorAnnouncementsEntryVariant(base)).toBe('empty');
  });

  it('shows the manage link to an owner who already has announcements', () => {
    expect(creatorAnnouncementsEntryVariant({ ...base, announcementCount: 2 })).toBe('manage');
  });

  // An unsettled count reads as zero. Without this gate an owner with announcements sees the
  // "post your first one" prompt on every load until the query settles, then watches it swap.
  it('renders nothing while the count is still loading, rather than assuming zero', () => {
    expect(
      creatorAnnouncementsEntryVariant({
        ...base,
        announcementsLoading: true,
        announcementCount: 0,
      })
    ).toBeNull();
  });

  // A failed fetch is an UNKNOWN count, not an empty one: isLoading is already false and the data has
  // fallen back to [], so gating on loading alone shows the first-announcement prompt to a creator
  // with ten of them. Do not collapse this into the loading check.
  it('renders nothing when the count failed to load, rather than assuming zero', () => {
    expect(
      creatorAnnouncementsEntryVariant({
        ...base,
        announcementsErrored: true,
        announcementCount: 0,
      })
    ).toBeNull();
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
  it('hides it from a muted owner, whose announcements do not render', () => {
    expect(
      creatorAnnouncementsEntryVariant({ ...base, profileUserMuted: true, announcementCount: 2 })
    ).toBeNull();
  });

  // Built from CREATOR_STUDIO_URL rather than spelled out, so a spoke rename does not redden an
  // announcements test — but still exact, so an interposed path segment fails here.
  it('deep-links to the announcements page, not the Creator Studio root', () => {
    expect(CREATOR_ANNOUNCEMENTS_URL).toBe(`${CREATOR_STUDIO_URL}/announcements`);
  });
});
