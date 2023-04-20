import { ImageSort } from '~/server/common/enums';
import { Carousel } from '@mantine/carousel';
import {
  ActionIcon,
  AspectRatio,
  Box,
  Center,
  createStyles,
  useMantineTheme,
  Button,
  Container,
  Text,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconInfoCircle } from '@tabler/icons';

import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { Reactions } from '~/components/Reaction/Reactions';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { NextLink } from '@mantine/next';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { useQueryImages } from '~/components/Image/image.utils';
import { MetricTimeframe } from '@prisma/client';

export function ResourceReviewCarousel({
  username,
  modelVersionId,
  reviewId,
}: {
  username: string;
  modelVersionId: number;
  reviewId: number;
}) {
  const { classes, theme } = useStyles();
  const mobile = useMediaQuery(`(max-width: ${theme.breakpoints.sm}px)`);

  const filters = {
    username,
    modelVersionId,
    sort: ImageSort.MostReactions,
    period: MetricTimeframe.AllTime,
    limit: 10,
  };

  const { data, images } = useQueryImages(filters);

  // const images = data?.pages.flatMap((x) => x.items) ?? [];
  const viewMore = data?.pages.some((x) => x.nextCursor !== undefined) ?? false;

  if (!images?.length) return null;

  return (
    <Box
      mb="md"
      sx={(theme) => ({
        background: theme.colorScheme === 'dark' ? theme.colors.dark[9] : theme.colors.gray[2],
      })}
    >
      <Container py="md">
        <Carousel
          key={reviewId}
          classNames={classes}
          slideSize="50%"
          breakpoints={[{ maxWidth: 'sm', slideSize: '100%', slideGap: 5 }]}
          slideGap="xl"
          align={images.length > 2 ? 'end' : 'center'}
          withControls={images.length > 2 ? true : false}
          slidesToScroll={mobile ? 1 : 2}
          loop
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
                        <RoutedContextLink modal="imageDetailModal" imageId={image.id} {...filters}>
                          {/* {!safe ? (
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
                      )} */}
                          <AspectRatio
                            ratio={1}
                            sx={(theme) => ({
                              width: '100%',
                              borderRadius: theme.radius.md,
                              overflow: 'hidden',
                            })}
                          >
                            {!safe ? (
                              <MediaHash {...image} />
                            ) : (
                              <EdgeImage
                                src={image.url}
                                name={image.name ?? image.id.toString()}
                                alt={image.name ?? undefined}
                                width={450}
                                placeholder="empty"
                                style={{ width: '100%', objectPosition: 'top' }}
                              />
                            )}
                          </AspectRatio>
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
              {/* <Button
            component={NextLink}
            href={`/images?modelVersionId=${modelVersionId}&username=${username}`}
            variant="outline"
            fullWidth
            className={classes.viewMore}
          >
            View more
          </Button> */}
              <AspectRatio
                ratio={1}
                sx={(theme) => ({
                  width: '100%',
                  borderRadius: theme.radius.md,
                  overflow: 'hidden',
                })}
              >
                <Button
                  component={NextLink}
                  href={`/images?modelVersionId=${modelVersionId}&username=${username}`}
                  variant="outline"
                  fullWidth
                  className={classes.viewMore}
                  radius="md"
                >
                  View more
                </Button>
              </AspectRatio>
            </Carousel.Slide>
          )}
        </Carousel>
        <Text size="xs" color="dimmed" mt="xs" mb="-xs">
          Images this user generated with this resource
        </Text>
      </Container>
    </Box>
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
