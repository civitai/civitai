import { CREATOR_STUDIO_URL } from '~/shared/constants/creator-studio.constants';

export const CREATOR_ANNOUNCEMENTS_URL = `${CREATOR_STUDIO_URL}/announcements`;

export type CreatorAnnouncementsEntryVariant = 'empty' | 'manage';

export function creatorAnnouncementsEntryVariant({
  featureEnabled,
  currentUserId,
  profileUserId,
  profileUserMuted,
  announcementCount,
}: {
  featureEnabled: boolean;
  currentUserId?: number | null;
  profileUserId: number;
  profileUserMuted: boolean;
  announcementCount: number;
}): CreatorAnnouncementsEntryVariant | null {
  if (!featureEnabled) return null;
  if (profileUserMuted) return null;
  if (currentUserId == null || currentUserId !== profileUserId) return null;

  return announcementCount > 0 ? 'manage' : 'empty';
}
