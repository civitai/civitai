import { Menu } from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import React from 'react';
import { AnnouncementMuteMenuItem } from '~/components/Announcements/AnnouncementMuteToggle';
import { DeleteCreatorAnnouncementButton } from '~/components/Announcements/DeleteCreatorAnnouncementButton';
import type { CreatorAnnouncement } from '~/components/Announcements/creator-announcement.types';
import { useMutedCreators } from '~/components/Announcements/creator-announcements.utils';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/shared/utils/report-helpers';

/**
 * The options menu on a creator announcement, shared by the notifications panel and the author's
 * profile carousel.
 */
export function AnnouncementActionsMenu({ announcement }: { announcement: CreatorAnnouncement }) {
  const currentUser = useCurrentUser();
  const mutedCreatorIds = useMutedCreators();
  const isOwnAnnouncement = currentUser?.id === announcement.userId;

  return (
    <Menu withinPortal position="bottom-end">
      <Menu.Target>
        <LegacyActionIcon
          variant="subtle"
          color="gray"
          radius="xl"
          aria-label="Announcement options"
        >
          <IconDotsVertical size={16} />
        </LegacyActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {/* Muting needs an author to mute; deleting does not, and a moderator should not lose
            the control on the row most likely to need it. */}
        {!!announcement.user && (
          <AnnouncementMuteMenuItem
            creatorId={announcement.user.id}
            creatorName={announcement.user.username}
            muted={mutedCreatorIds.includes(announcement.user.id)}
          />
        )}
        {!isOwnAnnouncement && (
          <ReportMenuItem
            label="Report announcement"
            onReport={() =>
              openReportModal({
                entityType: ReportEntity.Announcement,
                entityId: announcement.id,
              })
            }
          />
        )}
        <DeleteCreatorAnnouncementButton announcement={announcement} as="menu-item" />
      </Menu.Dropdown>
    </Menu>
  );
}
