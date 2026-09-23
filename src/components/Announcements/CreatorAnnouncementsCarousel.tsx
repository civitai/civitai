import React from 'react';
import { AnnouncementActionsMenu } from '~/components/Announcements/AnnouncementActionsMenu';
import { AnnouncementCarouselFrame } from '~/components/Announcements/AnnouncementCarouselFrame';
import { CreatorAnnouncement } from '~/components/Announcements/CreatorAnnouncement';
import { useQueryCreatorAnnouncements } from '~/components/Announcements/creator-announcements.utils';

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
          actions={<AnnouncementActionsMenu announcement={announcement} />}
        />
      )}
    </AnnouncementCarouselFrame>
  );
}
