import { Carousel } from '@mantine/carousel';
import { ActionIcon, Box, Card, Center, createStyles, Loader } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { ImageProps } from '~/components/ImageViewer/ImageViewer';
import { useEffect, useMemo } from 'react';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { ImageGuard2, ImageGuardConnect } from '~/components/ImageGuard/ImageGuard2';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import {
  ExplainHiddenImages,
  useExplainHiddenImages,
} from '~/components/Image/ExplainHiddenImages/ExplainHiddenImages';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';

const useStyles = createStyles((theme) => ({
  control: {
    svg: {
      width: 24,
      height: 24,

      [containerQuery.smallerThan('sm')]: {
        minWidth: 16,
        minHeight: 16,
      },
    },
  },
  carousel: {
    display: 'block',
    [containerQuery.smallerThan('md')]: {
      display: 'none',
    },
  },
  mobileBlock: {
    display: 'block',
    [containerQuery.largerThan('md')]: {
      display: 'none',
    },
  },
  loader: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
    zIndex: 1,
  },
  loadingCarousel: {
    pointerEvents: 'none',
    opacity: 0.5,
  },
  footer: {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    background: theme.fn.gradient({
      from: 'rgba(37,38,43,0.8)',
      to: 'rgba(37,38,43,0)',
      deg: 0,
    }),
    // backdropFilter: 'blur(13px) saturate(160%)',
    boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
    zIndex: 10,
    gap: 6,
    padding: theme.spacing.xs,
  },
  reactions: {
    position: 'absolute',
    bottom: 6,
    left: 6,
    borderRadius: theme.radius.sm,
    background:
      theme.colorScheme === 'dark'
        ? theme.fn.rgba(theme.colors.dark[6], 0.6)
        : theme.colors.gray[0],
    // backdropFilter: 'blur(13px) saturate(160%)',
    boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
    padding: 4,
  },
  info: {
    position: 'absolute',
    bottom: 5,
    right: 5,
  },
  viewport: {
    overflowX: 'clip',
    overflowY: 'visible',
  },
  meta: {
    position: 'absolute',
    bottom: '10px',
    right: '10px',
  },
}));

export function ImageCarousel(props: Props) {
  return (
    <BrowsingLevelProvider>
      <ImageCarouselContent {...props} />
    </BrowsingLevelProvider>
  );
}

export function ImageCarouselContent({
  images,
  connectType,
  connectId,
  mobile = false,
  onClick,
  isLoading: loading,
  onImageChange,
}: Props) {
  const { classes, cx } = useStyles();

  const transformed = useMemo(
    () =>
      images.map((image) => ({
        ...image,
        tagIds: image.tags?.map((x) => (typeof x === 'number' ? x : x.id)),
      })),
    [images]
  );

  const { items: filteredImages, loadingPreferences } = useApplyHiddenPreferences({
    type: 'images',
    data: transformed,
  });
  const isLoading = loading || loadingPreferences;
  const hiddenExplained = useExplainHiddenImages(transformed);

  useEffect(() => {
    if (filteredImages.length > 0) {
      onImageChange?.(mobile ? [filteredImages[0]] : filteredImages.slice(0, 2));
    }
  }, [filteredImages]);

  if (isLoading)
    return (
      <Box
        className={cx(!mobile && classes.carousel, mobile && classes.mobileBlock)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: mobile ? 300 : 600,
        }}
      >
        <Center>
          <Loader size="md" />
        </Center>
      </Box>
    );

  return (
    <Box pos="relative">
      <Carousel
        key={connectId}
        className={cx(
          !mobile && classes.carousel,
          mobile && classes.mobileBlock,
          isLoading && classes.loadingCarousel
        )}
        classNames={classes}
        slideSize="50%"
        breakpoints={[{ maxWidth: 'sm', slideSize: '100%', slideGap: 2 }]}
        slideGap="xl"
        align={filteredImages.length > 1 ? 'start' : 'center'}
        slidesToScroll="auto"
        withControls={filteredImages.length > 2 ? true : false}
        controlSize={mobile ? 32 : 56}
        loop
        onSlideChange={(index) => {
          if (onImageChange) {
            onImageChange(
              mobile ? [filteredImages[index]] : filteredImages.slice(index, index + 2)
            );
          }
        }}
      >
        {filteredImages.map((image) => (
          <Carousel.Slide key={image.id}>
            <Box
              sx={{ cursor: 'pointer' }}
              onClick={onClick ? () => onClick(image) : undefined}
              tabIndex={0}
              role="button"
              onKeyDown={
                onClick
                  ? (e) => {
                      const keyDown = e.key !== undefined ? e.key : e.keyCode;
                      if (
                        keyDown === 'Enter' ||
                        keyDown === 13 ||
                        ['Spacebar', ' '].indexOf(keyDown as string) >= 0 ||
                        keyDown === 32
                      ) {
                        // (prevent default so the page doesn't scroll when pressing space)
                        e.preventDefault();
                        onClick(image);
                      }
                    }
                  : undefined
              }
            >
              <Center className="size-full">
                <div className="relative w-full">
                  <ImageGuard2 image={image} connectType={connectType} connectId={connectId}>
                    {(safe) => (
                      <>
                        <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                        <ImageContextMenu image={image} className="absolute right-2 top-2 z-10" />
                        <ImagePreview
                          image={image}
                          edgeImageProps={{
                            width: 450,
                            style: { objectPosition: mobile ? 'top' : 'center' },
                          }}
                          // radius="md"
                          style={{ width: '100%' }}
                          aspectRatio={1}
                          nsfw={!safe}
                        />
                        {image.meta && (
                          <ImageMetaPopover meta={image.meta} imageId={image.id}>
                            <ActionIcon variant="light" className={classes.meta}>
                              <IconInfoCircle color="white" strokeWidth={2.5} size={18} />
                            </ActionIcon>
                          </ImageMetaPopover>
                        )}
                      </>
                    )}
                  </ImageGuard2>
                </div>
              </Center>
            </Box>
          </Carousel.Slide>
        ))}
        {hiddenExplained.hasHidden && (
          <Carousel.Slide>
            <Card withBorder component={Center} mih={450} h="100%" w="100%">
              <ExplainHiddenImages {...hiddenExplained} />
            </Card>
          </Carousel.Slide>
        )}
      </Carousel>
    </Box>
  );
}

type Props = {
  images: ImageProps[];
  mobile?: boolean;
  onClick?: (image: ImageProps) => void;
  isLoading?: boolean;
  onImageChange?: (images: ImageProps[]) => void;
} & ImageGuardConnect;
