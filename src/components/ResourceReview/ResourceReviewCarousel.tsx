import { ImageSort } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';
import { Carousel } from '@mantine/carousel';
import {
  ActionIcon,
  AspectRatio,
  Box,
  Center,
  createStyles,
  Loader,
  useMantineTheme,
  Card,
  Button,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconInfoCircle } from '@tabler/icons';
import { useRouter } from 'next/router';

import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { Reactions } from '~/components/Reaction/Reactions';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { NextLink } from '@mantine/next';

export function ResourceReviewCarousel({
  username,
  modelVersionId,
  reviewId,
}: {
  username: string;
  modelVersionId: number;
  reviewId: number;
}) {
  const router = useRouter();
  const theme = useMantineTheme();
  const mobile = useMediaQuery(`(max-width: ${theme.breakpoints.sm}px)`);
  const { classes, cx } = useStyles();

  const { data, isLoading } = trpc.image.getInfinite.useInfiniteQuery({
    username,
    modelVersionId,
    limit: 10,
    sort: ImageSort.Newest,
  });

  const images = data?.pages.flatMap((x) => x.items) ?? [];
  const viewMore = data?.pages.some((x) => x.nextCursor !== undefined) ?? false;

  if (isLoading)
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 300,
        }}
      >
        <Center>
          <Loader size="md" />
        </Center>
      </Box>
    );

  if (!images) return null;

  return (
    <Carousel
      key={reviewId}
      classNames={classes}
      slideSize="50%"
      breakpoints={[{ maxWidth: 'sm', slideSize: '100%', slideGap: 5 }]}
      slideGap="xl"
      align={images.length > 2 ? 'end' : 'center'}
      withControls={images.length > 2 ? true : false}
      slidesToScroll={mobile ? 1 : 2}
    >
      <ImageGuard
        images={images}
        connect={{ entityId: reviewId, entityType: 'review' }}
        render={(image) => (
          <Carousel.Slide>
            <ImageGuard.Content>
              {({ safe }) => (
                <Center style={{ height: '100%', width: '100%' }}>
                  <div style={{ width: '100%', position: 'relative' }}>
                    <ImageGuard.ToggleConnect />
                    <ImageGuard.Report />
                    <RoutedContextLink
                      modal="imageDetailModal"
                      imageId={image.id}
                      modelVersionId={modelVersionId}
                      username={username}
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
                        <ImagePreview
                          image={image}
                          edgeImageProps={{ width: 450 }}
                          radius="md"
                          style={{ width: '100%' }}
                        />
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
                      withinPortal
                      className={classes.reactions}
                    />
                    {!image.hideMeta && image.meta && (
                      <ImageMetaPopover
                        meta={image.meta as any}
                        generationProcess={image.generationProcess ?? undefined}
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
        )}
      />
      {viewMore && (
        <Carousel.Slide style={{ display: 'flex', alignItems: 'center' }}>
          <Button
            component={NextLink}
            href={`/images?modelVersionId=${modelVersionId}&username=${username}`}
            variant="outline"
            fullWidth
            className={classes.viewMore}
          >
            View more
          </Button>
        </Carousel.Slide>
      )}
    </Carousel>
  );
}

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

  viewMore: {
    maxHeight: '100%',
    height: 500,
    width: '100%',
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
}));
