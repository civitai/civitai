import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';
import React, { useRef } from 'react';
import { Announcement } from '~/components/Announcements/Announcement';
import { Carousel } from '@mantine/carousel';
import autoplay from 'embla-carousel-autoplay';
import { useContainerWidth } from '~/components/ContainerProvider/ContainerProvider';
import { useDebouncedValue } from '@mantine/hooks';

export function Announcements() {
  const autoplayRef = useRef(autoplay({ delay: 10000 }));
  const { data } = useGetAnnouncements();
  const width = useContainerWidth();
  const widthDebounced = useDebouncedValue(width, 50);

  const announcements = data.filter((x) => !x.dismissed);

  if (!announcements.length) return null;

  return (
    // Required custom class to apply certain styles based on peer elements
    // eslint-disable-next-line tailwindcss/no-custom-classname
    <div className="announcements peer container mb-3">
      <Carousel
        key={`${widthDebounced}`}
        withIndicators={announcements.length > 1}
        withControls={false}
        slideGap="md"
        plugins={[autoplayRef.current]}
        loop
      >
        {announcements.map((announcement) => (
          <Carousel.Slide key={announcement.id}>
            <Announcement announcement={announcement} className="h-full" />
          </Carousel.Slide>
        ))}
      </Carousel>
    </div>
  );
}
