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
  announcementsErrored,
}: {
  featureEnabled: boolean;
  currentUserId?: number | null;
  profileUserId: number;
  profileUserMuted: boolean;
  announcementCount: number;
  announcementsLoading: boolean;
  announcementsErrored: boolean;
}): CreatorAnnouncementsEntryVariant | null {
  if (!featureEnabled) return null;
  if (profileUserMuted) return null;
  if (currentUserId !== profileUserId) return null;

  // An unknown count reads as zero, which would show the "post your first one" prompt to a creator
  // who already has announcements. A failed fetch is unknown too, not empty — `isLoading` is false by
  // then and the data falls back to [], so dropping the error half reinstates the bug on that path.
  if (announcementsLoading || announcementsErrored) return null;

  return announcementCount > 0 ? 'manage' : 'empty';
}
