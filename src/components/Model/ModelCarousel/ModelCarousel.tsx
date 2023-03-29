import { Carousel } from '@mantine/carousel';
import {
  ActionIcon,
  AspectRatio,
  Box,
  Button,
  Center,
  createStyles,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons';
import { useRouter } from 'next/router';

import { useGalleryFilters } from '~/components/Gallery/GalleryFilters';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { Reactions } from '~/components/Reaction/Reactions';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { ImageGetInfinite } from '~/types/router';

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
}));

export function ModelCarousel({
  modelId,
  modelVersionId,
  modelUserId,
  images,
  nsfw,
  mobile = false,
  loading = false,
  limit = 10,
}: Props) {
  const router = useRouter();
  const { classes, cx } = useStyles();
  const { filters, clearFilters } = useGalleryFilters();

  if (loading)
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

  if (!loading && !images.length) {
    const hasTagFilters = filters.tags && filters.tags.length > 0;

    return (
      <Paper
        p="xl"
        radius="md"
        className={cx(!mobile && classes.carousel, mobile && classes.mobileBlock)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: mobile ? 300 : 600,
        }}
        withBorder
      >
        <Stack>
          <Stack spacing={4}>
            <Text size="lg">No images found</Text>
            <Text size="sm" color="dimmed">
              {hasTagFilters
                ? 'Try removing your images filters'
                : 'Be the first to share your creation for this model'}
            </Text>
          </Stack>
          <Group position="center">
            <Button
              variant="outline"
              onClick={() =>
                hasTagFilters
                  ? clearFilters()
                  : router.push(`/posts/create?modelId=${modelId}&modelVersionId=${modelVersionId}`)
              }
            >
              {hasTagFilters ? 'Clear Filters' : 'Share Images'}
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
                      prioritizedUserIds={[modelUserId]}
                      limit={limit}
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
                        <>
                          <ImagePreview
                            image={image}
                            edgeImageProps={{ width: 400 }}
                            radius="md"
                            style={{ width: '100%' }}
                          />
                          <div className={classes.footer}>
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
                            />
                            {!image.hideMeta && image.meta && (
                              <ImageMetaPopover
                                meta={image.meta as any}
                                generationProcess={image.generationProcess ?? undefined}
                              >
                                <ActionIcon variant="transparent" size="sm">
                                  <IconInfoCircle
                                    color="white"
                                    filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                                    opacity={0.8}
                                    strokeWidth={2.5}
                                    size={18}
                                  />
                                </ActionIcon>
                              </ImageMetaPopover>
                            )}
                          </div>
                        </>
                      )}
                    </RoutedContextLink>
                  </div>
                </Center>
              )}
            </ImageGuard.Content>
          </Carousel.Slide>
        )}
      />
    </Carousel>
  );
}

type Props = {
  images: ImageGetInfinite;
  modelVersionId: number;
  modelId: number;
  modelUserId: number;
  nsfw: boolean;
  mobile?: boolean;
  loading?: boolean;
  limit?: number;
};
