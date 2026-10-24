import autoplay from 'embla-carousel-autoplay';
import React, { useRef } from 'react';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';

export function AnnouncementCarouselFrame<T extends { id: number }>({
  items,
  className,
  children,
}: {
  items: T[];
  className?: string;
  children: (item: T) => React.ReactNode;
}) {
  const autoplayRef = useRef(autoplay({ delay: 10000 }));

  if (!items.length) return null;

  return (
    <div className={className}>
      <Embla plugins={[autoplayRef.current]} loop withIndicators={items.length > 1}>
        <Embla.Viewport>
          <Embla.Container className="-ml-4 flex">
            {items.map((item, index) => (
              <Embla.Slide key={item.id} index={index} className="flex-[0_0_100%] pl-4">
                {children(item)}
              </Embla.Slide>
            ))}
          </Embla.Container>
        </Embla.Viewport>
      </Embla>
    </div>
  );
}
