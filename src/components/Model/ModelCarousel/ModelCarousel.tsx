import { Carousel } from '@mantine/carousel';
import {
  ActionIcon,
  AspectRatio,
  Box,
  Button,
  Center,
  createStyles,
  Group,
  Indicator,
  Loader,
  Paper,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { IconBrush, IconInfoCircle, IconPhotoOff } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { generationPanel } from '~/store/generation.store';

import { useQueryImages } from '~/components/Image/image.utils';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { Reactions } from '~/components/Reaction/Reactions';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ImageSort } from '~/server/common/enums';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { ExplainHiddenImages } from '~/components/Image/ExplainHiddenImages/ExplainHiddenImages';

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
    background: theme.fn.rgba(
      theme.colorScheme === 'dark' ? theme.colors.dark[9] : theme.colors.gray[0],
      0.8
    ),
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

export function ModelCarousel({
  modelId,
  modelVersionId,
  modelUserId,
  // images,
  mobile = false,
  limit = 10,
  onBrowseClick,
}: Props) {
  const router = useRouter();
  const currentUser = useCurrentUser();
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

  if (!isLoading && !images.length) {
    return (
      <Paper
        p="sm"
        radius="md"
        className={cx(!mobile && classes.carousel, mobile && classes.mobileBlock)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: mobile ? 300 : 500,
        }}
        withBorder
      >
        <Stack align="center" maw={380}>
          <Stack spacing={4} align="center">
            <ThemeIcon color="gray" size={64} radius={100}>
              <IconPhotoOff size={32} />
            </ThemeIcon>
            <Text size="lg">No showcase images available</Text>
            <ExplainHiddenImages images={flatData} />
            {/* <Text size="sm" color="dimmed" ta="center">
              {currentUser
                ? `No images from this creator match your content preferences. Adjust your settings or explore the community gallery below.`
                : `No images from this creator match the default content preferences. Log in to adjust your settings or explore the community gallery below.`}
            </Text> */}
          </Stack>
          {/* <Group grow w="100%">
            {currentUser ? (
              <Link href="/user/account#content-moderation">
                <Button variant="outline">Adjust Settings</Button>
              </Link>
            ) : (
              <Link href={`/login?returnUrl=${router.asPath}`}>
                <Button variant="outline">Log In</Button>
              </Link>
            )}
            <Button onClick={onBrowseClick} variant="outline">
              Browse Gallery
            </Button>
          </Group> */}
        </Stack>
      </Paper>
    );
  }

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
      {images.map((image) => {
        const fromCommunity = image.user.id !== modelUserId;
        return (
          <Carousel.Slide key={image.id}>
            <Center style={{ height: '100%', width: '100%' }}>
              <div style={{ width: '100%', position: 'relative' }}>
                <ImageGuard2 image={image} connectType="model" connectId={modelId}>
                  {(safe) => (
                    <>
                      <ImageGuard2.BlurToggle className="absolute top-2 left-2 z-10" />
                      <Stack spacing="xs" align="flex-end" className="absolute top-2 right-2 z-10">
                        <ImageContextMenu image={image} />
                        {features.imageGeneration && image.meta && (
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
                                type: 'image',
                                id: image.id,
                              });
                            }}
                          >
                            <IconBrush stroke={2.5} size={16} />
                          </HoverActionButton>
                        )}
                      </Stack>
                      <RoutedDialogLink name="imageDetail" state={{ imageId: image.id, images }}>
                        {!safe ? (
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
                        ) : (
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
                              radius="md"
                              style={{ width: '100%' }}
                            />
                          </Indicator>
                        )}
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
                    </>
                  )}
                </ImageGuard2>
                {!image.hideMeta && image.meta && (
                  <ImageMetaPopover
                    meta={image.meta}
                    generationProcess={image.generationProcess ?? undefined}
                    imageId={image.id}
                    mainResourceId={modelVersionId}
                  >
                    <ActionIcon className={classes.info} variant="transparent" size="lg">
                      <IconInfoCircle
                        color="white"
                        filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                        opacity={0.8}
                        strokeWidth={2.5}
                        size={26}
                      />
                    </ActionIcon>
                  </ImageMetaPopover>
                )}
              </div>
            </Center>
          </Carousel.Slide>
        );
      })}
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
