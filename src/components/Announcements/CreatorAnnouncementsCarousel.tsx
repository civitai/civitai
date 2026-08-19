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

export function DeleteCreatorAnnouncementButton({
  announcement,
}: {
  announcement: CreatorAnnouncementModel;
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

  return (
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
