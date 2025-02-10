import { Carousel } from '@mantine/carousel';
import {
  ActionIcon,
  Box,
  Card,
  Center,
  createStyles,
  Indicator,
  Loader,
  Stack,
} from '@mantine/core';
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
import { ImageSort } from '~/server/common/enums';
import { generationPanel } from '~/store/generation.store';
import { containerQuery } from '~/utils/mantine-css-helpers';

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
    [containerQuery.smallerThan('sm')]: {
      display: 'none',
    },
  },
  mobileBlock: {
    display: 'block',
    [containerQuery.largerThan('sm')]: {
      display: 'none',
    },
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
  contentOverlay: {
    position: 'absolute',
    width: '100%',
    left: 0,
    zIndex: 10,
    padding: theme.spacing.sm,
  },
  top: { top: 0 },
}));

export function ModelCarousel(props: Props) {
  return (
    <BrowsingLevelProvider>
      <ModelCarouselContent {...props} />
    </BrowsingLevelProvider>
  );
}

function ModelCarouselContent({
  modelId,
  modelVersionId,
  modelUserId,
  // images,
  mobile = false,
  limit = 10,
  onBrowseClick,
}: Props) {
  const features = useFeatureFlags();
  const { classes, cx } = useStyles();

  const { images, flatData, isLoading } = useQueryImages({
    modelVersionId: modelVersionId,
    prioritizedUserIds: [modelUserId],
    period: 'AllTime',
    sort: ImageSort.MostReactions,
    limit,
    pending: true,
  });

  const hiddenExplained = useExplainHiddenImages(flatData);

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
    <Carousel
      key={modelId}
      className={cx(!mobile && classes.carousel, mobile && classes.mobileBlock)}
      classNames={classes}
      slideSize="50%"
      breakpoints={[{ maxWidth: 'md', slideSize: '100%', slideGap: 2 }]}
      slideGap="xl"
      align={images.length > 2 ? 'start' : 'center'}
      slidesToScroll="auto"
      withControls={images.length > 2 ? true : false}
      controlSize={mobile ? 32 : 56}
      loop
    >
      {images.map((image) => {
        const fromCommunity = image.user.id !== modelUserId;
        return (
          <Carousel.Slide key={image.id}>
            <Center h="100%" w="100%">
              <div style={{ width: '100%', position: 'relative' }}>
                <ImageGuard2 image={image} connectType="model" connectId={modelId}>
                  {(safe) => (
                    <>
                      <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                      <Stack spacing="xs" align="flex-end" className="absolute right-2 top-2 z-10">
                        <ImageContextMenu image={image} />
                        {features.imageGeneration && (image.hasPositivePrompt ?? image.hasMeta) && (
                          <HoverActionButton
                            label="Remix"
                            size={30}
                            color="white"
                            variant="filled"
                            data-activity="remix:model-carousel"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              generationPanel.open({
                                type: image.type,
                                id: image.id,
                              });
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
            </Center>
          </Carousel.Slide>
        );
      })}
      {hiddenExplained.hasHidden && (
        <Carousel.Slide>
          <Card withBorder component={Center} mih={450} h="100%" w="100%">
            <ExplainHiddenImages {...hiddenExplained} />
          </Card>
        </Carousel.Slide>
      )}
    </Carousel>
  );
}

type Props = {
  modelVersionId: number;
  modelId: number;
  modelUserId: number;
  mobile?: boolean;
  limit?: number;
  onBrowseClick?: VoidFunction;
};
