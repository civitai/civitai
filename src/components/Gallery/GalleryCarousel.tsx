import { GetGalleryImagesReturnType } from '~/server/controllers/image.controller';
import { useRouter } from 'next/router';
import { createStyles, UnstyledButton, Center } from '@mantine/core';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons';
import { ImageGuard, ImageGuardConnect } from '~/components/ImageGuard/ImageGuard';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { useAspectRatioFit } from '~/hooks/useAspectRatioFit';
import { useHotkeys } from '@mantine/hooks';
import { QS } from '~/utils/qs';

type GalleryCarouselProps = {
  current: GetGalleryImagesReturnType[0];
  images: GetGalleryImagesReturnType;
  className?: string;
  connect?: ImageGuardConnect;
};

/**NOTES**
  - when our current image is not found in the images array, we can navigate away from it, but we can't use the arrows to navigate back to it.
*/
export function GalleryCarousel({ current, images, className, connect }: GalleryCarouselProps) {
  const router = useRouter();
  const { classes, cx } = useStyles();
  const index = images.findIndex((x) => x.id === current.id);
  const prevIndex = index - 1;
  const nextIndex = index + 1;

  const { setRef, height, width } = useAspectRatioFit({
    height: current.height ?? 1200,
    width: current.width ?? 1200,
  });

  // #region [navigation]
  const canNavigate = index > -1 ? images.length > 1 : images.length > 0; // see notes
  const handleNavigate = (id: number) => {
    const { galleryImageId, ...query } = router.query;
    const [, queryString] = router.asPath.split('?');
    router.replace(
      { query: { ...query, galleryImageId: id } },
      { pathname: `/gallery/${id}`, query: { ...QS.parse(queryString) } as any },
      { shallow: true }
    );
  };

  const handlePrev = () => {
    if (canNavigate) {
      const id = prevIndex > -1 ? images[prevIndex].id : images[images.length - 1].id;
      handleNavigate(id);
    }
  };

  const handleNext = () => {
    if (canNavigate) {
      const id = nextIndex < images.length ? images[nextIndex].id : images[0].id;
      handleNavigate(id);
    }
  };
  useHotkeys([
    ['ArrowLeft', handlePrev],
    ['ArrowRight', handleNext],
  ]);
  // #endregion

  return (
    <div ref={setRef} className={cx(classes.root, className)}>
      {canNavigate && (
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
                <ImageGuard.ToggleImage />
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
      {/* TODO.gallery - indicators */}
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
