import { Carousel, Embla } from '@mantine/carousel';
import { useHotkeys, useLocalStorage, useOs } from '@mantine/hooks';

import { truncate } from 'lodash-es';
import { useState, useEffect, useRef } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { shouldDisplayHtmlControls } from '~/components/EdgeMedia/EdgeMedia.util';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { ConnectProps, ImageGuardContent } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { useAspectRatioFit } from '~/hooks/useAspectRatioFit';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { constants } from '~/server/common/constants';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import useIsClient from '~/hooks/useIsClient';
import { EdgeVideoRef } from '~/components/EdgeMedia/EdgeVideo';

type ImageProps = { videoRef?: React.ForwardedRef<EdgeVideoRef> };

export function ImageDetailCarousel(props: ImageProps) {
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
        key={images.length}
        withControls={canNavigate}
        className="flex-1"
        onSlideChange={handleSlideChange}
        getEmblaApi={setEmbla}
        height="100%"
        initialSlide={index}
        draggable={!isDesktop && canNavigate}
        loop
        withKeyboardEvents={false}
        // withIndicators={images.length <= maxIndicators && images.length > 1}
      >
        {images.map((image, i) => (
          <Carousel.Slide key={image.id}>
            {index === i && <ImageContent image={image} {...connect} {...props} />}
          </Carousel.Slide>
        ))}
      </Carousel>
    </div>
  );
}

function ImageContent({
  image,
  videoRef,
}: { image: ImagesInfiniteModel } & ConnectProps & ImageProps) {
  const [defaultMuted, setDefaultMuted] = useLocalStorage({
    getInitialValueInEffect: false,
    key: 'detailView_defaultMuted',
    defaultValue: true,
  });

  // We'll be using the client to avoid mis-reading te defaultMuted settings on videos.
  const isClient = useIsClient();

  const { setRef, height, width } = useAspectRatioFit({
    height: image?.height ?? 1200,
    width: image?.width ?? 1200,
  });

  const isVideo = image?.type === 'video';

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
              alt={image.name ?? undefined}
              type={image.type}
              className={`max-h-full w-auto max-w-full ${!safe ? 'invisible' : ''}`}
              wrapperProps={{
                className: `max-h-full w-auto max-w-full ${!safe ? 'invisible' : ''}`,
                style: { aspectRatio: (image?.width ?? 0) / (image?.height ?? 0) },
              }}
              width={!isVideo || isClient ? image.width : 450}
              anim={isClient}
              controls
              quality={90}
              original={isVideo && isClient ? true : undefined}
              html5Controls={shouldDisplayHtmlControls(image)}
              muted={defaultMuted}
              onMutedChange={(isMuted) => {
                setDefaultMuted(isMuted);
              }}
              videoRef={videoRef}
            />
          )}
        </div>
      )}
    </ImageGuardContent>
  );
}
