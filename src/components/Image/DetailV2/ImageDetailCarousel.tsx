import { Carousel, Embla } from '@mantine/carousel';

import { truncate } from 'lodash-es';
import { useState, useEffect, useRef } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { ConnectProps, ImageGuardContent } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { useAspectRatioFit } from '~/hooks/useAspectRatioFit';
import { constants } from '~/server/common/constants';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import { isDefined } from '~/utils/type-guards';

export function ImageDetailCarousel() {
  const { images, index, canNavigate, connect, navigate } = useImageDetailContext();
  const renderRef = useRef<ImagesInfiniteModel[]>([]);
  renderRef.current = [images[index - 1], images[index], images[index + 1]].filter(isDefined);

  const [embla, setEmbla] = useState<Embla | null>(null);
  const [slidesInView, setSlidesInView] = useState<number[]>(() => {
    const renderIndex = renderRef.current.findIndex((x) => x.id === images[index].id);
    return [renderIndex > -1 ? renderIndex : 0];
  });
  console.log({ index, renderImages: renderRef.current });

  const handleSlideChange = (slide: number) => {
    const renderImage = renderRef.current[slide];
    console.log('change', index, renderRef.current);
    const imageId = images.find((x) => x.id === renderImage.id)?.id;
    if (imageId) navigate(imageId);
  };

  useEffect(() => {
    if (!embla) return;
    const onSelect = () => setSlidesInView([...embla.slidesInView(true), ...embla.slidesInView()]);
    embla.on('select', onSelect);
    return () => {
      embla.off('select', onSelect);
    };
  }, [embla]);

  useEffect(() => {
    setTimeout(() => {
      embla?.reInit();
    }, 0);
  }, [index]);

  if (!images.length) return null;

  return (
    <div className="flex justify-stretch items-stretch flex-1">
      <Carousel
        withControls={canNavigate}
        draggable={canNavigate}
        className="flex-1"
        onSlideChange={handleSlideChange}
        getEmblaApi={setEmbla}
        height="100%"
        initialSlide={slidesInView[0]}
      >
        {renderRef.current.map((image, index) => (
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
        <div ref={setRef} className="h-full w-full flex justify-center items-center">
          {!safe ? (
            <div className="relative max-h-full max-w-full " style={{ height, width }}>
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
              className={`max-w-full max-h-full w-auto ${!safe ? 'invisible' : ''}`}
              width="original"
              anim
              controls
              fadeIn
            />
          )}
        </div>
      )}
    </ImageGuardContent>
  );
}
