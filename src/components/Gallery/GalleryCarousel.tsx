import { GetGalleryImagesReturnType } from '~/server/controllers/image.controller';
import { useRouter } from 'next/router';
import { createStyles, UnstyledButton, Center } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons';
import { ImageGuard, ImageGuardConnect } from '~/components/ImageGuard/ImageGuard';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { useRef, useState } from 'react';
import { useDebouncedState, useWindowEvent } from '@mantine/hooks';
import { QS } from '~/utils/qs';

/**
 * Conserve aspect ratio of the original region. Useful when shrinking/enlarging
 * images to fit into a certain area.
 *
 * @param {Number} srcWidth width of source image
 * @param {Number} srcHeight height of source image
 * @param {Number} maxWidth maximum available width
 * @param {Number} maxHeight maximum available height
 * @return {Object} { width, height }
 */
function calculateAspectRatioFit(
  srcWidth: number,
  srcHeight: number,
  maxWidth: number,
  maxHeight: number
) {
  if (srcWidth > maxWidth || srcHeight > maxHeight) {
    const ratio = Math.min(maxWidth / srcWidth, maxHeight / srcHeight);

    return { width: srcWidth * ratio, height: srcHeight * ratio };
  } else {
    return { width: srcWidth, height: srcHeight };
  }
}

type GalleryCarouselProps = {
  current: GetGalleryImagesReturnType[0];
  images: GetGalleryImagesReturnType;
  className?: string;
  connect?: ImageGuardConnect;
};

/**NOTES**

*/
export function GalleryCarousel({ current, images, className, connect }: GalleryCarouselProps) {
  const router = useRouter();
  const { classes, cx } = useStyles();
  const index = images.findIndex((x) => x.id === current.id);
  const prevIndex = index - 1;
  const nextIndex = index + 1;

  // #region [aspect ratio calculations]
  // used for getting/setting correct aspectRatio of canvas
  const containerRef = useRef<HTMLDivElement>(null);
  const container = {
    width: containerRef.current?.clientWidth ?? 0,
    height: containerRef.current?.clientHeight ?? 0,
  };
  const getAspectRatio = () =>
    calculateAspectRatioFit(
      current.width ?? 1200,
      current.height ?? 1200,
      container.width,
      container.height
    );

  const [resized, setResized] = useDebouncedState(0, 200);
  const { width, height } = getAspectRatio();
  const handleResize = () => setResized(resized + 1); // use this to reset component
  useWindowEvent('resize', handleResize);
  // #endregion

  // #region [navigation]
  const handleNavigate = (id: number) => {
    const { galleryImageId, ...query } = router.query;
    const [, queryString] = router.asPath.split('?');
    const pathname = `/gallery/${id}`;
    const asPath = !!queryString.length ? `${pathname}?${queryString}` : pathname;
    router.replace({ pathname: `/gallery/${id}`, query }, asPath, { shallow: true });
  };

  const handlePrev = () => {
    const id = prevIndex > -1 ? images[prevIndex].id : images[images.length - 1].id;
    handleNavigate(id);
  };

  const handleNext = () => {
    const id = nextIndex < images.length ? images[nextIndex].id : images[0].id;
    handleNavigate(id);
  };
  // #endregion

  return (
    <div ref={containerRef} className={cx(classes.root, className)}>
      {images.length > 0 && (
        <>
          <UnstyledButton className={cx(classes.control, classes.prev)} onClick={handlePrev}>
            <IconChevronLeft />
          </UnstyledButton>
          <UnstyledButton className={cx(classes.control, classes.next)} onClick={handleNext}>
            <IconChevronRight />
          </UnstyledButton>
        </>
      )}
      <ImageGuard
        images={[current]}
        connect={connect}
        // nsfw={nsfw}
        render={(image) => {
          return (
            <Center
              sx={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
              }}
            >
              <Center
                style={{
                  position: 'relative',
                  height: height,
                  width: width,
                }}
              >
                <ImageGuard.ToggleConnect />
                <ImageGuard.Unsafe>
                  <MediaHash {...image} />
                </ImageGuard.Unsafe>
                <ImageGuard.Safe>
                  <EdgeImage
                    src={image.url}
                    alt={image.name ?? undefined}
                    style={{ maxHeight: '100%', maxWidth: '100%' }}
                    width={image.width ?? 1200}
                  />
                </ImageGuard.Safe>
              </Center>
            </Center>
          );
        }}
      />
    </div>
  );
}

const useStyles = createStyles((theme, _props, getRef) => {
  return {
    root: {
      position: 'relative',
    },
    center: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
    },

    prev: { ref: getRef('prev') },
    next: { ref: getRef('next') },
    control: {
      position: 'absolute',
      // top: 0,
      // bottom: 0,
      top: '50%',
      transform: 'translateY(-50%)',
      zIndex: 10,

      svg: {
        height: 50,
        width: 50,
      },

      [`&.${getRef('prev')}`]: {
        left: 0,
      },
      [`&.${getRef('next')}`]: {
        right: 0,
      },

      '&:hover': {
        color: theme.colors.blue[3],
      },
    },
  };
});
