import { useGetAnnouncements } from '~/components/Announcements/announcements.utils';
import clsx from 'clsx';
import React, { useRef } from 'react';
import { Announcement } from '~/components/Announcements/Announcement';
import autoplay from 'embla-carousel-autoplay';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';
import type { AnnouncementType } from '~/server/schema/announcement.schema';

export default function AnnouncementsCarousel({
  className,
  type = 'site',
  minHeight,
}: {
  className?: string;
  type?: AnnouncementType;
  // Optional floor (px) so the carousel holds the space previously reserved by
  // the pre-hydration placeholder (feed-CLS reserve) — keeps the swap from the
  // placeholder to the real carousel from reflowing the feed below it.
  minHeight?: number;
}) {
  const autoplayRef = useRef(autoplay({ delay: 10000 }));
  const { data } = useGetAnnouncements(type);

  const announcements = data.filter((x) => !x.dismissed);

  if (!announcements.length) return null;

  return (
    // Required custom class to apply certain styles based on peer elements
    // eslint-disable-next-line tailwindcss/no-custom-classname
    <div className={clsx('announcements peer container', className)} style={{ minHeight }}>
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
