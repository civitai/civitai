import { Carousel, Embla } from '@mantine/carousel';
import { useHotkeys, useOs } from '@mantine/hooks';

import { truncate } from 'lodash-es';
import { useState, useEffect, useRef } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { ConnectProps, ImageGuardContent } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { useAspectRatioFit } from '~/hooks/useAspectRatioFit';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { constants } from '~/server/common/constants';
import { ImagesInfiniteModel } from '~/server/services/image.service';

export function ImageDetailCarousel() {
  const { images, index, canNavigate, connect, navigate } = useImageDetailContext();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const [embla, setEmbla] = useState<Embla | null>(null);
  const [slidesInView, setSlidesInView] = useState<number[]>([index]);

  const handleSlideChange = (slide: number) => {
    const imageId = images[slide]?.id;
    if (imageId) navigateRef.current(imageId);
  };

  useEffect(() => {
    if (!embla) return;
    const onSelect = () => {
      setSlidesInView([...embla.slidesInView(true)]);
    };

    embla.on('select', onSelect);
    return () => {
      embla.off('select', onSelect);
    };
  }, [embla]);

  function next() {
    embla?.scrollNext();
  }

  function prev() {
    embla?.scrollPrev();
  }

  useHotkeys([
    ['ArrowLeft', prev],
    ['ArrowRight', next],
  ]);

  const ref = useResizeObserver<HTMLDivElement>(() => {
    embla?.reInit();
  });

  const os = useOs();
  const isDesktop = os === 'windows' || os === 'linux' || os === 'macos';

  useEffect(() => {
    if (!slidesInView.includes(index)) {
      embla?.scrollTo(index, true);
      // setSlidesInView([...embla.slidesInView(true)]);
    }
  }, [index, slidesInView]); // eslint-disable-line

  if (!images.length) return null;

  return (
    <div ref={ref} className="flex min-h-0 flex-1 items-stretch justify-stretch">
      <Carousel
        withControls={canNavigate}
        className="flex-1"
        onSlideChange={handleSlideChange}
        getEmblaApi={setEmbla}
        height="100%"
        initialSlide={slidesInView[0]}
        draggable={!isDesktop && canNavigate}
        loop
        withKeyboardEvents={false}
        // withIndicators={images.length <= maxIndicators && images.length > 1}
      >
        {images.map((image, index) => (
          <Carousel.Slide key={image.id}>
            {slidesInView.includes(index) && <ImageContent image={image} {...connect} />}
          </Carousel.Slide>
        ))}
      </Carousel>
    </div>
  );
}

function ImageContent({ image }: { image: ImagesInfiniteModel } & ConnectProps) {
  const { setRef, height, width } = useAspectRatioFit({
    height: image?.height ?? 1200,
    width: image?.width ?? 1200,
  });

  return (
    <ImageGuardContent image={image}>
      {(safe) => (
        <div ref={setRef} className="relative flex size-full items-center justify-center">
          {!safe ? (
            <div className="relative size-full" style={{ maxHeight: height, maxWidth: width }}>
              <MediaHash {...image} />
            </div>
          ) : (
            <EdgeMedia
              src={image.url}
              name={image.name ?? image.id.toString()}
              alt={
                image.meta
                  ? truncate(image.meta.prompt, { length: constants.altTruncateLength })
                  : image.name ?? undefined
              }
              type={image.type}
              className={`max-h-full w-auto max-w-full ${!safe ? 'invisible' : ''}`}
              wrapperProps={{
                className: `max-h-full w-auto max-w-full ${!safe ? 'invisible' : ''}`,
                style: { aspectRatio: (image?.width ?? 0) / (image?.height ?? 0) },
              }}
              width={image.width}
              anim
              controls
              quality={90}
              original={image.type === 'video' ? true : undefined}
              // fadeIn
            />
          )}
        </div>
      )}
    </ImageGuardContent>
  );
}
