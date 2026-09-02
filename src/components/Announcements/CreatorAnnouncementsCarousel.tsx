import { Menu } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconTrash } from '@tabler/icons-react';
import React from 'react';
import { AnnouncementCarouselFrame } from '~/components/Announcements/AnnouncementCarouselFrame';
import { CreatorAnnouncement } from '~/components/Announcements/CreatorAnnouncement';
import type { CreatorAnnouncement as CreatorAnnouncementModel } from '~/components/Announcements/creator-announcement.types';
import {
  useDeleteCreatorAnnouncement,
  useQueryCreatorAnnouncements,
} from '~/components/Announcements/creator-announcements.utils';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';

/**
 * Who may delete, and the confirm step. Shared so the profile's icon button and the panel's
 * menu item cannot drift apart on either — the permission is the load-bearing half.
 */
function useDeleteCreatorAnnouncementAction(announcement: CreatorAnnouncementModel) {
  const currentUser = useCurrentUser();
  const { deleteAnnouncement, isLoading } = useDeleteCreatorAnnouncement();

  const canDelete =
    !!currentUser && (currentUser.isModerator || currentUser.id === announcement.userId);

  const confirmDelete = () =>
    openConfirmModal({
      title: 'Delete announcement',
      children: 'Are you sure you want to delete this announcement? This cannot be undone.',
      labels: { cancel: "No, don't delete it", confirm: 'Delete announcement' },
      confirmProps: { color: 'red' },
      onConfirm: () => deleteAnnouncement(announcement.id),
    });

  return { canDelete, isLoading, confirmDelete };
}

export function DeleteCreatorAnnouncementButton({
  announcement,
}: {
  announcement: CreatorAnnouncementModel;
}) {
  const { canDelete, isLoading, confirmDelete } = useDeleteCreatorAnnouncementAction(announcement);
  if (!canDelete) return null;

  return (
    <LegacyActionIcon
      variant="subtle"
      color="red"
      radius="xl"
      loading={isLoading}
      onClick={confirmDelete}
      aria-label="Delete announcement"
    >
      <IconTrash size={18} />
    </LegacyActionIcon>
  );
}

/**
 * The same action as a menu entry. In the panel the card's top bar is chrome the reader
 * scans, so a destructive control does not belong loose in it.
 */
export function DeleteCreatorAnnouncementMenuItem({
  announcement,
}: {
  announcement: CreatorAnnouncementModel;
}) {
  const { canDelete, confirmDelete } = useDeleteCreatorAnnouncementAction(announcement);
  if (!canDelete) return null;

  return (
    <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={confirmDelete}>
      Delete announcement
    </Menu.Item>
  );
}

export function CreatorAnnouncementsCarousel({
  userId,
  className,
}: {
  userId: number;
  className?: string;
}) {
  const { announcements } = useQueryCreatorAnnouncements(userId);

  return (
    <AnnouncementCarouselFrame items={announcements} className={className}>
      {(announcement) => (
        <CreatorAnnouncement
          announcement={announcement}
          className="h-full"
          actions={<DeleteCreatorAnnouncementButton announcement={announcement} />}
        />
      )}
    </AnnouncementCarouselFrame>
  );
}
