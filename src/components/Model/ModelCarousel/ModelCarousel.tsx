import { ActionIcon, Card, Center, createStyles, Indicator, Loader, Stack } from '@mantine/core';
import { IconBrush, IconInfoCircle } from '@tabler/icons-react';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import {
  ExplainHiddenImages,
  useExplainHiddenImages,
} from '~/components/Image/ExplainHiddenImages/ExplainHiddenImages';
import { useQueryImages } from '~/components/Image/image.utils';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { Reactions } from '~/components/Reaction/Reactions';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { ImageSort } from '~/server/common/enums';
import { generationPanel } from '~/store/generation.store';
import { BrowsingSettingsAddonsProvider } from '~/providers/BrowsingSettingsAddonsProvider';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';

const useStyles = createStyles((theme) => ({
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
}));

export function ModelCarousel(props: Props) {
  return (
    <BrowsingLevelProvider>
      <BrowsingSettingsAddonsProvider>
        <ModelCarouselContent {...props} />
      </BrowsingSettingsAddonsProvider>
    </BrowsingLevelProvider>
  );
}

function ModelCarouselContent({ modelId, modelVersionId, modelUserId, limit = 10 }: Props) {
  const features = useFeatureFlags();
  const { classes } = useStyles();

  const { running, helpers } = useTourContext();

  const { images, flatData, isLoading } = useQueryImages({
    modelVersionId: modelVersionId,
    prioritizedUserIds: [modelUserId],
    period: 'AllTime',
    sort: ImageSort.MostReactions,
    limit,
    pending: true,
  });

  const hiddenExplained = useExplainHiddenImages(flatData);
  const mobile = useContainerSmallerThan('md');

  if (isLoading)
    return (
      <div className="flex items-center justify-center" style={{ minHeight: mobile ? 300 : 600 }}>
        <Loader size="md" />
      </div>
    );

  const totalItems = images.length + (hiddenExplained.hasHidden ? 1 : 0);
  const slidesToShow = mobile ? 1 : 2;

  return (
    <Embla
      key={modelVersionId}
      align={totalItems > slidesToShow ? 'start' : 'center'}
      slidesToScroll={1}
      withControls={totalItems > slidesToShow ? true : false}
      controlSize={mobile ? 32 : 56}
      loop
      initialHeight={mobile ? 300 : 600}
    >
      <Embla.Viewport>
        <Embla.Container className="-ml-3 flex @md:-ml-6">
          {images.map((image, index) => {
            const fromCommunity = image.user.id !== modelUserId;
            return (
              <Embla.Slide
                key={image.id}
                index={index}
                className="flex flex-[0_0_100%] items-center justify-center pl-3 @md:flex-[0_0_50%] @md:pl-6"
              >
                <div className="relative w-full">
                  <ImageGuard2 image={image} connectType="model" connectId={modelId}>
                    {(safe) => (
                      <>
                        <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                        <Stack
                          spacing="xs"
                          align="flex-end"
                          className="absolute right-2 top-2 z-10"
                        >
                          <ImageContextMenu image={image} />
                          {features.imageGeneration &&
                            (image.hasPositivePrompt ?? image.hasMeta) && (
                              <HoverActionButton
                                label="Remix"
                                size={30}
                                color="white"
                                variant="filled"
                                data-activity="remix:model-carousel"
                                data-tour="model:remix"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();

                                  generationPanel.open({
                                    type: image.type,
                                    id: image.id,
                                  });

                                  if (running) helpers?.next();
                                }}
                              >
                                <IconBrush stroke={2.5} size={16} />
                              </HoverActionButton>
                            )}
                        </Stack>
                        <RoutedDialogLink name="imageDetail" state={{ imageId: image.id, images }}>
                          <Indicator
                            label="From Community"
                            radius="sm"
                            position="top-center"
                            size={24}
                            disabled={!fromCommunity}
                            withBorder
                          >
                            <ImagePreview
                              image={image}
                              edgeImageProps={{ width: 450 }}
                              aspectRatio={(image.width ?? 1) / (image.height ?? 1)}
                              // radius="md"
                              style={{ width: '100%' }}
                              nsfw={!safe}
                            />
                          </Indicator>
                        </RoutedDialogLink>
                        <Reactions
                          entityId={image.id}
                          entityType="image"
                          reactions={image.reactions}
                          metrics={{
                            likeCount: image.stats?.likeCountAllTime,
                            dislikeCount: image.stats?.dislikeCountAllTime,
                            heartCount: image.stats?.heartCountAllTime,
                            laughCount: image.stats?.laughCountAllTime,
                            cryCount: image.stats?.cryCountAllTime,
                          }}
                          readonly={!safe}
                          className={classes.reactions}
                          targetUserId={image.user.id}
                          disableBuzzTip={image.poi}
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
          {hiddenExplained.hasHidden && (
            <Embla.Slide className="flex-[0_0_100%] pl-3 @md:flex-[0_0_50%] @md:pl-6">
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
  modelVersionId: number;
  modelId: number;
  modelUserId: number;
  limit?: number;
};
