import { IconX } from '@tabler/icons-react';
import React from 'react';
import { AnnouncementCard } from '~/components/Announcements/AnnouncementCard';
import {
  dismissAnnouncements,
  useAnnouncementsStore,
} from '~/components/Announcements/announcements.utils';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import type { AnnouncementDTO } from '~/server/services/announcement.service';

/**
 * A sitewide (Civitai-authored) announcement. Layout lives in `AnnouncementCard`, shared
 * with the creator variant so the two cannot drift apart; everything here is the part that
 * is specific to a platform announcement — dismissal and moderator controls.
 */
export function Announcement({
  announcement,
  dismissible,
  moderatorActions,
  ...props
}: {
  announcement: AnnouncementDTO;
  dismissible?: boolean;
  moderatorActions?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const { actions, image } = announcement.metadata || {};
  const announcementType = announcement.metadata.type ?? 'site';
  const dismissed = useAnnouncementsStore((state) => state.dismissed[announcementType]);
  const canDismiss = dismissed.includes(announcement.id)
    ? false
    : dismissible ?? announcement.metadata.dismissible ?? true;

  function handleDismiss() {
    dismissAnnouncements(announcement.id, announcementType);
  }

  return (
    <AnnouncementCard
      title={announcement.title}
      content={announcement.content}
      color={announcement.color}
      // A bare storage key, not an Image row — see AnnouncementCardCover.
      cover={image ? { kind: 'key', src: image } : null}
      actions={actions ?? []}
      controls={moderatorActions}
      overlay={
        canDismiss ? (
          <LegacyActionIcon
            variant="subtle"
            radius="xl"
            color="red"
            onClick={handleDismiss}
            className="absolute right-2 top-2"
            aria-label="Dismiss announcement"
          >
            <IconX size={20} />
          </LegacyActionIcon>
        ) : null
      }
      {...props}
    />
  );
}
