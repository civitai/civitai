import { ActionIcon, Card, Loader, Modal, Paper, Text, Title } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';
import { useJoinKnightsNewOrder } from '~/components/Games/KnightsNewOrder.utils';
import { useQueryImages } from '~/components/Image/image.utils';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { useIsMobile } from '~/hooks/useIsMobile';
import {
  browsingLevelDescriptions,
  browsingLevelLabels,
  browsingLevels,
  type BrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';

export default function NewOrderRulesModal() {
  const { viewedRatingGuide, setViewedRatingGuide } = useJoinKnightsNewOrder();
  const dialog = useDialogContext();

  const handleClose = () => {
    if (!viewedRatingGuide) setViewedRatingGuide(true);
    dialog.onClose();
  };

  return (
    <Modal
      {...dialog}
      onClose={handleClose}
      size="80%"
      title="Rating Guide"
      classNames={{
        title: 'text-xl font-semibold text-gold-9',
      }}
      centered
    >
      <div className="flex flex-col gap-4">
        <Text>
          Below you&apos;ll find a list of example images that we have compiled as guide for you to
          identify which images our system and the community have rated as each rating level.
        </Text>
        <ul className="list-disc pl-8">
          <li>
            The images are representative of the browsing level, but may not be the exact same image
            you will see in the game.
          </li>
          <li>
            They are not exhaustive, and there may be other images that fit the same browsing level.
          </li>
          <li>
            They are not meant to be offensive or disturbing, but rather to provide a guide for the
            community to identify which images are appropriate for each rating level.
          </li>
        </ul>
        {browsingLevels.map((level) => (
          <Card key={level} className="flex flex-col gap-2 bg-gray-1 dark:bg-dark-6">
            <div className="flex flex-col gap-0">
              <Title order={3} className="text-lg font-semibold text-gold-9">
                {browsingLevelLabels[level]}
              </Title>
              <Text>{browsingLevelDescriptions[level]}</Text>
            </div>
            <BrowsingLevelCarousel browsingLevel={level} />
          </Card>
        ))}
      </div>
    </Modal>
  );
}

function BrowsingLevelCarousel({
  browsingLevel,
  limit = 10,
}: {
  browsingLevel: BrowsingLevel;
  limit?: number;
}) {
  const mobile = useIsMobile({ breakpoint: 'sm' });
  const { images, isLoading } = useQueryImages({
    limit,
    browsingLevel,
    // Special collection for New Order rating guide
    collectionId: 10615797,
  });

  if (isLoading)
    return (
      <div className="flex items-center justify-center" style={{ minHeight: mobile ? 300 : 600 }}>
        <Loader size="md" />
      </div>
    );

  if (!isLoading && !images.length)
    return (
      <Paper className="flex h-32 w-full items-center justify-center" radius="md">
        <Text className="text-center text-lg">No images available for this browsing level.</Text>
      </Paper>
    );

  const totalItems = images.length;
  const slidesToShow = mobile ? 1 : 4;

  return (
    <Embla
      align={totalItems > slidesToShow ? 'start' : 'center'}
      withControls={totalItems > slidesToShow ? true : false}
      controlSize={32}
      initialHeight={300}
      loop
    >
      <Embla.Viewport>
        <Embla.Container className="-ml-3 flex md:-ml-6">
          {images.map((image, index) => {
            return (
              <Embla.Slide
                key={image.id}
                index={index}
                className="flex flex-[0_0_100%] items-center justify-center pl-3 md:flex-[0_0_25%] md:pl-6"
              >
                <div className="relative w-full">
                  <ImageGuard2 image={image}>
                    {(safe) => (
                      <>
                        <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                        <ImagePreview
                          image={image}
                          edgeImageProps={{ width: 450 }}
                          aspectRatio={(image.width ?? 1) / (image.height ?? 1)}
                          // radius="md"
                          style={{ width: '100%', maxHeight: mobile ? 510 : 370 }}
                          nsfw={!safe}
                        />
                        {image.hasMeta && (
                          <div className="absolute bottom-0.5 right-0.5 z-10">
                            <ImageMetaPopover2 imageId={image.id} type={image.type}>
                              <ActionIcon variant="transparent" size="lg">
                                <IconInfoCircle
                                  color="white"
                                  filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                                  opacity={0.8}
                                  strokeWidth={2.5}
                                  size={26}
                                />
                              </ActionIcon>
                            </ImageMetaPopover2>
                          </div>
                        )}
                      </>
                    )}
                  </ImageGuard2>
                </div>
              </Embla.Slide>
            );
          })}
        </Embla.Container>
      </Embla.Viewport>
    </Embla>
  );
}
