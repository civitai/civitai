import { CREATOR_STUDIO_URL } from '~/shared/constants/creator-studio.constants';

export const CREATOR_ANNOUNCEMENTS_URL = `${CREATOR_STUDIO_URL}/announcements`;

export type CreatorAnnouncementsEntryVariant = 'empty' | 'manage';

export function creatorAnnouncementsEntryVariant({
  featureEnabled,
  currentUserId,
  profileUserId,
  profileUserMuted,
  announcementCount,
  announcementsLoading,
}: {
  featureEnabled: boolean;
  currentUserId?: number | null;
  profileUserId: number;
  profileUserMuted: boolean;
  announcementCount: number;
  announcementsLoading: boolean;
}): CreatorAnnouncementsEntryVariant | null {
  if (!featureEnabled) return null;
  if (profileUserMuted) return null;
  if (currentUserId !== profileUserId) return null;

  // An unsettled count reads as zero, which would show the "post your first one" prompt to a creator
  // who already has announcements — the one state the carousel above deliberately renders nothing in.
  if (announcementsLoading) return null;

  return announcementCount > 0 ? 'manage' : 'empty';
}
