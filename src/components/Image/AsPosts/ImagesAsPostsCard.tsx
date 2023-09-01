import { Carousel, Embla } from '@mantine/carousel';
import {
  ActionIcon,
  createStyles,
  Group,
  Paper,
  Rating,
  Center,
  Tooltip,
  Text,
} from '@mantine/core';
import { IconExclamationMark, IconInfoCircle, IconMessage } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { InView } from 'react-intersection-observer';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useImagesAsPostsInfiniteContext } from '~/components/Image/AsPosts/ImagesAsPostsInfinite';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { Reactions } from '~/components/Reaction/Reactions';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { ImagesAsPostModel } from '~/server/controllers/image.controller';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { trpc } from '~/utils/trpc';
import { NextLink } from '@mantine/next';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { StarRating } from '~/components/StartRating/StarRating';

export function ImagesAsPostsCard({
  data,
  width: cardWidth,
  height,
}: {
  data: ImagesAsPostModel;
  width: number;
  height: number;
}) {
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();
  const { filters, modelVersions } = useImagesAsPostsInfiniteContext();
  const modelVersionName = modelVersions?.find((x) => x.id === data.modelVersionId)?.name;
  const queryUtils = trpc.useContext();
  const postId = data.postId ?? undefined;
  const linkFilters = { ...filters, postId };

  const cover = data.images[0];
  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const carouselHeight = height - 58 - 8;

  const [embla, setEmbla] = useState<Embla | null>(null);
  const [slidesInView, setSlidesInView] = useState<number[]>([]);

  useEffect(() => {
    if (!embla) return;
    setSlidesInView(embla.slidesInView(true));
    const onSelect = () => setSlidesInView([...embla.slidesInView(true), ...embla.slidesInView()]);
    embla.on('select', onSelect);
    return () => {
      embla.off('select', onSelect);
    };
  }, [embla]);

  const handleClick = () => {
    queryUtils.image.getInfinite.setInfiniteData({ ...linkFilters, browsingMode }, () => {
      return {
        pages: [{ items: data.images, nextCursor: undefined, count: undefined }],
        pageParams: [],
      };
    });
  };

  const imageIdsString = data.images.map((x) => x.id).join('_');
  const carouselKey = useMemo(() => `${imageIdsString}_${cardWidth}`, [imageIdsString, cardWidth]);

  return (
    <InView rootMargin="200%">
      {({ inView, ref }) => (
        <MasonryCard
          withBorder
          shadow="sm"
          p={0}
          height={height}
          ref={ref}
          className={classes.card}
        >
          {inView && (
            <>
              <Paper radius={0}>
                <Group p="xs" align="flex-start" noWrap maw="100%">
                  <UserAvatar
                    user={data.user}
                    subText={
                      <>
                        <DaysFromNow date={data.createdAt} /> - {modelVersionName ?? 'Cross-post'}
                      </>
                    }
                    subTextForce
                    size="md"
                    spacing="xs"
                    withUsername
                    linkToProfile
                  />
                  <Group ml="auto" noWrap>
                    {!data.publishedAt && (
                      <Tooltip label="Post not Published" withArrow>
                        <ActionIcon
                          color="red"
                          variant="outline"
                          component={NextLink}
                          href={`/posts/${data.postId}/edit`}
                        >
                          <IconExclamationMark />
                        </ActionIcon>
                      </Tooltip>
                    )}
                    {data.review ? (
                      <RoutedContextLink modal="resourceReviewModal" reviewId={data.review.id}>
                        <IconBadge
                          className={classes.statBadge}
                          sx={{
                            userSelect: 'none',
                            paddingTop: 4,
                            paddingBottom: 4,
                            height: 'auto',
                          }}
                          style={{ paddingRight: data.review?.details ? undefined : 0 }}
                          icon={
                            <Group spacing={2} align="center" noWrap>
                              <StarRating size={14} value={data.review.rating / 5} count={1} />
                              <Text size="xs" sx={{ lineHeight: 1.2 }}>
                                {`${data.review.rating}.0`}
                              </Text>
                            </Group>
                          }
                        >
                          {data.review?.details && (
                            <Center>
                              <IconMessage size={18} strokeWidth={2.5} />
                            </Center>
                          )}
                        </IconBadge>
                      </RoutedContextLink>
                    ) : currentUser?.id === data.user.id ? (
                      <>{/* <Button compact>Add Review</Button> */}</>
                    ) : null}
                  </Group>
                </Group>
              </Paper>
              {data.images.length === 1 ? (
                <ImageGuard
                  images={[cover]}
                  render={(image) => (
                    <ImageGuard.Content>
                      {({ safe }) => (
                        <div className={classes.imageContainer}>
                          <ImageGuard.Report />
                          <ImageGuard.ToggleImage position="top-left" />
                          <RoutedContextLink
                            modal="imageDetailModal"
                            imageId={image.id}
                            onClick={handleClick}
                            className={classes.link}
                            {...linkFilters}
                          >
                            <>
                              <MediaHash {...image} />
                              {safe && (
                                <EdgeMedia
                                  src={image.url}
                                  name={image.name ?? image.id.toString()}
                                  alt={image.name ?? undefined}
                                  type={image.type}
                                  width={450}
                                  placeholder="empty"
                                  className={classes.image}
                                />
                              )}
                            </>
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
                      )}
                    </ImageGuard.Content>
                  )}
                />
              ) : (
                <Carousel
                  key={carouselKey}
                  withControls
                  draggable
                  loop
                  style={{ flex: 1 }}
                  withIndicators
                  controlSize={32}
                  height={carouselHeight}
                  getEmblaApi={setEmbla}
                  styles={{
                    indicators: {
                      bottom: 0,
                      zIndex: 5,
                      display: 'flex',
                      gap: 1,
                    },
                    indicator: {
                      width: 'auto',
                      height: 8,
                      flex: 1,
                      transition: 'width 250ms ease',
                      borderRadius: 0,
                      boxShadow: '0 0 3px rgba(0, 0, 0, .3)',
                    },
                  }}
                >
                  <ImageGuard
                    images={data.images}
                    connect={postId ? { entityType: 'post', entityId: postId } : undefined}
                    render={(image, index) => (
                      <Carousel.Slide className={classes.slide} sx={{ height: carouselHeight }}>
                        {slidesInView.includes(index) && (
                          <ImageGuard.Content>
                            {({ safe }) => (
                              <div className={classes.imageContainer}>
                                <ImageGuard.Report />
                                <ImageGuard.ToggleConnect position="top-left" />
                                <RoutedContextLink
                                  modal="imageDetailModal"
                                  imageId={image.id}
                                  onClick={handleClick}
                                  className={classes.link}
                                  {...linkFilters}
                                >
                                  <>
                                    <MediaHash {...image} />
                                    {safe && (
                                      <EdgeMedia
                                        src={image.url}
                                        name={image.name ?? image.id.toString()}
                                        alt={image.name ?? undefined}
                                        type={image.type}
                                        width={450}
                                        placeholder="empty"
                                        className={classes.image}
                                      />
                                    )}
                                  </>
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
                                    <ActionIcon
                                      className={classes.info}
                                      variant="transparent"
                                      size="lg"
                                    >
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
                            )}
                          </ImageGuard.Content>
                        )}
                      </Carousel.Slide>
                    )}
                  />
                </Carousel>
              )}
            </>
          )}
        </MasonryCard>
      )}
    </InView>
  );
}

const useStyles = createStyles((theme) => ({
  title: {
    lineHeight: 1.1,
    fontSize: 14,
    color: 'white',
    fontWeight: 500,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
  },
  link: {
    width: '100%',
    display: 'flex',
    justifyContent: 'center',
  },
  slide: {
    display: 'flex',
    flexDirection: 'column',
  },
  imageContainer: {
    position: 'relative',
    overflow: 'hidden',
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    // paddingBottom: 42,
    // background: theme.colors.dark[9],
    flexDirection: 'column',
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
    zIndex: 1,
  },
  info: {
    position: 'absolute',
    bottom: 5,
    right: 5,
    zIndex: 1,
  },
  statBadge: {
    background: 'rgba(212,212,212,0.2)',
    backdropFilter: 'blur(7px)',
    cursor: 'pointer',
  },
  image: {
    width: '100%',
    zIndex: 1,
    // position: 'absolute',
    // top: '50%',
    // left: 0,
    // transform: 'translateY(-50%)',
  },
}));
