import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';
import React from 'react';
import { Announcement } from '~/components/Announcements/Announcement';
import { Carousel } from '@mantine/carousel';

export function Announcements() {
  const { data } = useGetAnnouncements();

  const announcements = data.filter((x) => !x.dismissed);

  if (!announcements.length) return null;

  return (
    // Required custom class to apply certain styles based on peer elements
    // eslint-disable-next-line tailwindcss/no-custom-classname
    <div className="announcements peer container mb-3">
      <Carousel withIndicators={announcements.length > 1} withControls={false} slideGap="md">
        {announcements.map((announcement) => (
          <Carousel.Slide key={announcement.id}>
            <Announcement announcement={announcement} className="h-full" />
          </Carousel.Slide>
        ))}
      </Carousel>
    </div>
  );
}
