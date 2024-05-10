import { Carousel, Embla } from '@mantine/carousel';

import { truncate } from 'lodash-es';
import { useState, useEffect } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { ConnectProps, ImageGuardContent } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { constants } from '~/server/common/constants';
import { ImagesInfiniteModel } from '~/server/services/image.service';

export function ImageDetailCarousel() {
  const { images, image, next, previous, canNavigate, connect } = useImageDetailContext();
  const [embla, setEmbla] = useState<Embla | null>(null);
  const [slidesInView, setSlidesInView] = useState<number[]>(() => {
    const index = images.findIndex((x) => x.id === image?.id);
    return [index > -1 ? index : 0];
  });
  const _images = !images.length && image ? [image] : images;

  const handleNext = () => next();
  const handlePrev = () => previous();

  useEffect(() => {
    if (!embla) return;
    // setSlidesInView(embla.slidesInView(true));
    const onSelect = () => setSlidesInView([...embla.slidesInView(true), ...embla.slidesInView()]);

    embla.on('select', onSelect);
    return () => {
      embla.off('select', onSelect);
    };
  }, [embla]);

  if (!image) return null;

  return (
    <div className="flex justify-stretch items-stretch flex-1">
      {/* {!canNavigate ? (
        <ImageContent image={image} {...connect} />
      ) : ( */}
      <Carousel
        withControls={canNavigate}
        draggable
        loop
        className="flex-1"
        onNextSlide={handleNext}
        onPreviousSlide={handlePrev}
        getEmblaApi={setEmbla}
        height="100%"
      >
        {_images.map((image, index) => (
          <Carousel.Slide key={image.id} className="flex justify-center items-center">
            {slidesInView.includes(index) && <ImageContent image={image} {...connect} />}
          </Carousel.Slide>
        ))}
      </Carousel>
      {/* )} */}
    </div>
  );
}

function ImageContent({ image }: { image: ImagesInfiniteModel } & ConnectProps) {
  return (
    <ImageGuardContent image={image}>
      {(safe) => (
        <div
          className="relative max-h-full max-w-full "
          style={{ aspectRatio: (image.width ?? 0) / (image.height ?? 0) }}
        >
          {!safe && <MediaHash {...image} />}

          <EdgeMedia
            src={image.url}
            name={image.name ?? image.id.toString()}
            alt={
              image.meta
                ? truncate(image.meta.prompt, { length: constants.altTruncateLength })
                : image.name ?? undefined
            }
            type={image.type}
            className={`max-w-full max-h-full ${!safe ? 'invisible' : ''}`}
            width="original"
            anim
            controls
            fadeIn
          />
        </div>
      )}
    </ImageGuardContent>
  );
}
