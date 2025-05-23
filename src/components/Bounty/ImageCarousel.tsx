import { ActionIcon, Card, Center, Loader } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { ImageProps } from '~/components/ImageViewer/ImageViewer';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { ImageGuard2, ImageGuardConnect } from '~/components/ImageGuard/ImageGuard2';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import {
  ExplainHiddenImages,
  useExplainHiddenImages,
} from '~/components/Image/ExplainHiddenImages/ExplainHiddenImages';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';

import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';
import { breakpoints } from '~/utils/tailwind';
import { useMemo } from 'react';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { BrowsingSettingsAddonsProvider } from '~/providers/BrowsingSettingsAddonsProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function ImageCarousel(props: Props) {
  return (
    <BrowsingLevelProvider>
      <BrowsingSettingsAddonsProvider>
        <ImageCarouselContent {...props} />
      </BrowsingSettingsAddonsProvider>
    </BrowsingLevelProvider>
  );
}

export function ImageCarouselContent({
  images,
  connectType,
  connectId,
  onClick,
  isLoading: loading,
}: Props) {
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
  const mobile = useContainerSmallerThan('md');

  if (isLoading)
    return (
      <div className="flex items-center justify-center" style={{ minHeight: mobile ? 300 : 600 }}>
        <Loader size="md" />
      </div>
    );

  const totalItems = filteredImages.length + (hiddenExplained.hasHidden ? 1 : 0);
  const slidesToShow = mobile ? 1 : 2;

  return (
    <Embla
      key={connectId}
      align={totalItems > slidesToShow ? 'start' : 'center'}
      slidesToScroll={1}
      withControls={totalItems > slidesToShow ? true : false}
      controlSize={mobile ? 32 : 56}
      breakpoints={{
        [`(min-width: ${breakpoints.sm}px)`]: {
          slidesToScroll: 2,
        },
      }}
      loop
    >
      <Embla.Viewport>
        <Embla.Container className="flex">
          {filteredImages.map((image, index) => (
            <Embla.Slide
              key={image.id}
              index={index}
              className="flex-[0_0_100%] pl-3 @md:flex-[0_0_50%] @md:pl-6"
            >
              <div
                className="flex cursor-pointer items-center justify-center"
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
                <div className="relative">
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
                            <LegacyActionIcon
                              color="gray"
                              variant="light"
                              className="absolute bottom-2.5 right-2.5"
                            >
                              <IconInfoCircle color="white" strokeWidth={2.5} size={18} />
                            </LegacyActionIcon>
                          </ImageMetaPopover>
                        )}
                      </>
                    )}
                  </ImageGuard2>
                </div>
              </div>
            </Embla.Slide>
          ))}
          {hiddenExplained.hasHidden && (
            <Embla.Slide
              index={filteredImages.length}
              className="flex-[0_0_100%] pl-3 @md:flex-[0_0_50%] @md:pl-6"
            >
              <Card withBorder component={Center} mih={450} h="100%" w="100%">
                <ExplainHiddenImages {...hiddenExplained} />
              </Card>
            </Embla.Slide>
          )}
        </Embla.Container>
      </Embla.Viewport>
    </Embla>
  );
}

type Props = {
  images: ImageProps[];
  mobile?: boolean;
  onClick?: (image: ImageProps) => void;
  isLoading?: boolean;
} & ImageGuardConnect;
