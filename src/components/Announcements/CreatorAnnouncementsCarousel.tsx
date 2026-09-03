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
 * Delete an announcement, as an icon button or as a menu entry. One component with `as`
 * rather than two, following `HideUserButton` and its siblings: the permission, the confirm
 * step and the in-flight state cannot then differ between the two chromes.
 *
 * In the panel this lives in the options menu — a destructive control does not belong loose
 * in the card's top bar, which is chrome the reader scans.
 */
export function DeleteCreatorAnnouncementButton({
  announcement,
  as = 'button',
}: {
  announcement: CreatorAnnouncementModel;
  as?: 'menu-item' | 'button';
}) {
  const currentUser = useCurrentUser();
  const { deleteAnnouncement, isLoading } = useDeleteCreatorAnnouncement();

  const canDelete =
    !!currentUser && (currentUser.isModerator || currentUser.id === announcement.userId);
  if (!canDelete) return null;

  const handleDelete = () =>
    openConfirmModal({
      title: 'Delete announcement',
      children: 'Are you sure you want to delete this announcement? This cannot be undone.',
      labels: { cancel: "No, don't delete it", confirm: 'Delete announcement' },
      confirmProps: { color: 'red' },
      onConfirm: () => deleteAnnouncement(announcement.id),
    });

  return as === 'button' ? (
    <LegacyActionIcon
      variant="subtle"
      color="red"
      radius="xl"
      loading={isLoading}
      onClick={handleDelete}
      aria-label="Delete announcement"
    >
      <IconTrash size={18} />
    </LegacyActionIcon>
  ) : (
    <Menu.Item
      color="red"
      disabled={isLoading}
      leftSection={<IconTrash size={16} />}
      onClick={handleDelete}
    >
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
