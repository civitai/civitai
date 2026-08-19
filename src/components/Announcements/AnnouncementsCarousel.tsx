import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';
import clsx from 'clsx';
import React from 'react';
import { Announcement } from '~/components/Announcements/Announcement';
import { AnnouncementCarouselFrame } from '~/components/Announcements/AnnouncementCarouselFrame';
import type { AnnouncementType } from '~/server/schema/announcement.schema';

export default function AnnouncementsCarousel({
  className,
  type = 'site',
}: {
  className?: string;
  type?: AnnouncementType;
}) {
  const { data } = useGetAnnouncements(type);

  const announcements = data.filter((x) => !x.dismissed);

  return (
    <AnnouncementCarouselFrame
      items={announcements}
      // Required custom class to apply certain styles based on peer elements
      // eslint-disable-next-line tailwindcss/no-custom-classname
      className={clsx('announcements peer container', className)}
    >
      {(announcement) => <Announcement announcement={announcement} className="h-full" />}
    </AnnouncementCarouselFrame>
  );
}
