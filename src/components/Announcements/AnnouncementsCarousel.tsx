import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';
import React, { useRef } from 'react';
import { Announcement } from '~/components/Announcements/Announcement';
import autoplay from 'embla-carousel-autoplay';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';

export default function AnnouncementsCarousel() {
  const autoplayRef = useRef(autoplay({ delay: 10000 }));
  const { data } = useGetAnnouncements();

  const announcements = data.filter((x) => !x.dismissed);

  if (!announcements.length) return null;

  return (
    // Required custom class to apply certain styles based on peer elements
    // eslint-disable-next-line tailwindcss/no-custom-classname
    <div className="announcements peer container mb-3">
      <Embla plugins={[autoplayRef.current]} loop withIndicators={announcements.length > 1}>
        <Embla.Viewport>
          <Embla.Container className="-ml-4 flex">
            {announcements.map((announcement, index) => (
              <Embla.Slide key={announcement.id} index={index} className="flex-[0_0_100%] pl-4">
                <Announcement announcement={announcement} className="h-full" />
              </Embla.Slide>
            ))}
          </Embla.Container>
        </Embla.Viewport>
      </Embla>
    </div>
  );
}
