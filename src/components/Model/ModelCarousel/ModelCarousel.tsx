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
import { NextLink } from '@mantine/next';
import { IconInfoCircle, IconPhotoOff } from '@tabler/icons-react';
import { useRouter } from 'next/router';

import { useQueryImages } from '~/components/Image/image.utils';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { Reactions } from '~/components/Reaction/Reactions';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { ImageSort } from '~/server/common/enums';
import { ImageMetaProps } from '~/server/schema/image.schema';

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
    backdropFilter: 'blur(13px) saturate(160%)',
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
    backdropFilter: 'blur(13px) saturate(160%)',
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
}));

export function ModelCarousel({
  modelId,
  modelVersionId,
  modelUserId,
  // images,
  nsfw,
  mobile = false,
  limit = 10,
  onBrowseClick,
}: Props) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();

  const { images, isLoading } = useQueryImages({
    modelVersionId: modelVersionId,
    prioritizedUserIds: [modelUserId],
    period: 'AllTime',
    sort: ImageSort.MostReactions,
    limit,
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
            <Text size="sm" color="dimmed" ta="center">
              {currentUser
                ? `No images from this creator match your content preferences. Adjust your settings or explore the community gallery below.`
                : `No images from this creator match the default content preferences. Log in to adjust your settings or explore the community gallery below.`}
            </Text>
          </Stack>
          <Group grow w="100%">
            {currentUser ? (
              <Button
                component={NextLink}
                href="/user/account#content-moderation"
                variant="outline"
              >
                Adjust Settings
              </Button>
            ) : (
              <Button
                component={NextLink}
                href={`/login?returnUrl=${router.asPath}`}
                variant="outline"
              >
                Log In
              </Button>
            )}
            <Button onClick={onBrowseClick} variant="outline">
              Browse Gallery
            </Button>
          </Group>
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
      <ImageGuard
        images={images}
        nsfw={nsfw}
        connect={{ entityId: modelId, entityType: 'model' }}
        render={(image) => {
          const fromCommunity = image.user.id !== modelUserId;

          return (
            <Carousel.Slide>
              <ImageGuard.Content>
                {({ safe }) => (
                  <Center style={{ height: '100%', width: '100%' }}>
                    <div style={{ width: '100%', position: 'relative' }}>
                      <ImageGuard.ToggleConnect position="top-left" />
                      <ImageGuard.Report />
                      <RoutedContextLink
                        modal="imageDetailModal"
                        imageId={image.id}
                        modelVersionId={modelVersionId}
                        prioritizedUserIds={[modelUserId]}
                        period="AllTime"
                        sort={ImageSort.MostReactions}
                        limit={limit}
                        tags={[]}
                      >
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
                      </RoutedContextLink>
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
                      />
                      {!image.hideMeta && image.meta && (
                        <ImageMetaPopover
                          meta={image.meta}
                          generationProcess={image.generationProcess ?? undefined}
                          imageId={image.id}
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
                )}
              </ImageGuard.Content>
            </Carousel.Slide>
          );
        }}
      />
    </Carousel>
  );
}

type Props = {
  modelVersionId: number;
  modelId: number;
  modelUserId: number;
  nsfw: boolean;
  mobile?: boolean;
  limit?: number;
  onBrowseClick?: VoidFunction;
};
