import { Carousel } from '@mantine/carousel';
import { Center, AspectRatio, createStyles } from '@mantine/core';
import { useRouter } from 'next/router';

import { AnchorNoTravel } from '~/components/AnchorNoTravel/AnchorNoTravel';
import { CustomImageModel, ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { openRoutedContext } from '~/providers/RoutedContextProvider';

const useStyles = createStyles((theme) => ({
  control: {
    svg: {
      width: 24,
      height: 24,

      [theme.fn.smallerThan('sm')]: {
        minWidth: 16,
        minHeight: 16,
      },
    },
  },
  carousel: {
    display: 'block',
    [theme.fn.smallerThan('md')]: {
      display: 'none',
    },
  },
  mobileBlock: {
    display: 'block',
    [theme.fn.largerThan('md')]: {
      display: 'none',
    },
  },
}));

export function ModelCarousel({ modelId, modelVersionId, images, nsfw, mobile = false }: Props) {
  const router = useRouter();
  const { classes, cx } = useStyles();
  if (!images.length) return null;

  return (
    <Carousel
      key={modelId}
      className={cx(!mobile && classes.carousel, mobile && classes.mobileBlock)}
      classNames={classes}
      slideSize="50%"
      breakpoints={[{ maxWidth: 'sm', slideSize: '100%', slideGap: 2 }]}
      slideGap="xl"
      align={images.length > 2 ? 'start' : 'center'}
      slidesToScroll={mobile ? 1 : 2}
      withControls={images.length > 2 ? true : false}
      controlSize={mobile ? 32 : 56}
      loop
    >
      <ImageGuard
        images={images}
        nsfw={nsfw}
        connect={{ entityId: modelId, entityType: 'model' }}
        render={(image) => (
          <Carousel.Slide>
            <Center style={{ height: '100%', width: '100%' }}>
              <div style={{ width: '100%', position: 'relative' }}>
                <ImageGuard.ToggleConnect />
                <ImageGuard.ReportNSFW />
                <ImageGuard.Unsafe>
                  <AspectRatio
                    ratio={(image.width ?? 1) / (image.height ?? 1)}
                    sx={(theme) => ({
                      width: '100%',
                      borderRadius: theme.radius.md,
                      overflow: 'hidden',
                    })}
                  >
                    <MediaHash {...image} />
                  </AspectRatio>
                </ImageGuard.Unsafe>
                <ImageGuard.Safe>
                  <AnchorNoTravel
                    href={`/gallery/${
                      image.id
                    }?modelId=${modelId}&modelVersionId=${modelVersionId}&infinite=false&returnUrl=${encodeURIComponent(
                      router.asPath
                    )}`}
                  >
                    <ImagePreview
                      image={image}
                      edgeImageProps={{ width: 400 }}
                      radius="md"
                      onClick={() =>
                        openRoutedContext('galleryDetailModal', {
                          modelId,
                          modelVersionId,
                          galleryImageId: image.id,
                          infinite: false,
                          returnUrl: router.asPath,
                        })
                      }
                      style={{ width: '100%' }}
                      withMeta
                    />
                  </AnchorNoTravel>
                </ImageGuard.Safe>
              </div>
            </Center>
          </Carousel.Slide>
        )}
      />
    </Carousel>
  );
}

type Props = {
  images: CustomImageModel[];
  modelVersionId: number;
  modelId: number;
  nsfw: boolean;
  mobile?: boolean;
};
