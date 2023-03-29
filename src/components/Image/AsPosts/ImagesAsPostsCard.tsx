import { Carousel } from '@mantine/carousel';
import { ActionIcon, AspectRatio, createStyles, Group, Paper, Rating } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons';
import { useMemo } from 'react';
import { InView } from 'react-intersection-observer';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { useImagesAsPostsInfiniteContext } from '~/components/Image/AsPosts/ImagesAsPostsInfinite';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { Reactions } from '~/components/Reaction/Reactions';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { ImagesAsPostModel } from '~/server/controllers/image.controller';
import { trpc } from '~/utils/trpc';

export function ImagesAsPostsCard({
  data,
  width: cardWidth,
}: {
  data: ImagesAsPostModel;
  width: number;
}) {
  const { classes } = useStyles();
  const { modelId, username } = useImagesAsPostsInfiniteContext();
  const queryUtils = trpc.useContext();
  const postId = data.postId ?? undefined;

  const cover = data.images.sort((a, b) => {
    const aHeight = a.height ?? 0;
    const bHeight = b.height ?? 0;
    return aHeight > bHeight ? aHeight : bHeight;
  })[0];

  const imageHeight = useMemo(() => {
    if (!cover.width || !cover.height) return 300;
    const width = cardWidth > 0 ? cardWidth : 300;
    const aspectRatio = cover.width / cover.height;
    const imageHeight = Math.floor(width / aspectRatio);
    return Math.min(imageHeight, 600);
  }, [cardWidth, cover.width, cover.height]);

  const cardHeight = imageHeight + 60;

  const handleClick = () => {
    queryUtils.image.getInfinite.setInfiniteData({ postId, modelId }, () => {
      return {
        pages: [{ items: data.images, nextCursor: undefined }],
        pageParams: [],
      };
    });
  };

  return (
    <InView>
      {({ inView, ref }) => (
        <MasonryCard
          withBorder
          shadow="sm"
          p={0}
          height={cardHeight}
          ref={ref}
          className={classes.card}
        >
          {inView && (
            <>
              <Paper radius={0}>
                <Group position="apart" p="xs" noWrap>
                  <UserAvatar
                    user={data.user}
                    subText={<DaysFromNow date={data.createdAt} />}
                    subTextForce
                    size="md"
                    spacing="xs"
                    withUsername
                    linkToProfile
                  />
                  {data.review && <Rating value={data.review?.rating} readOnly />}
                </Group>
              </Paper>
              {data.images.length === 1 ? (
                <ImageGuard
                  images={[cover]}
                  render={(image) => (
                    <ImageGuard.Content>
                      {({ safe }) => (
                        <>
                          <div className={classes.imageContainer}>
                            <ImageGuard.Report />
                            <ImageGuard.ToggleImage
                              sx={(theme) => ({
                                backgroundColor: theme.fn.rgba(theme.colors.red[9], 0.4),
                                color: 'white',
                                backdropFilter: 'blur(7px)',
                                boxShadow: '1px 2px 3px -1px rgba(37,38,43,0.2)',
                              })}
                            />
                            <RoutedContextLink
                              modal="imageDetailModal"
                              imageId={cover.id}
                              modelId={modelId}
                              postId={postId}
                              username={username}
                              onClick={handleClick}
                              className={classes.link}
                            >
                              <>
                                {!safe ? (
                                  <AspectRatio
                                    ratio={(image?.width ?? 1) / (image?.height ?? 1)}
                                    sx={{ width: '100%' }}
                                  >
                                    <MediaHash {...image} />
                                  </AspectRatio>
                                ) : (
                                  <EdgeImage
                                    src={image.url}
                                    name={image.name ?? image.id.toString()}
                                    alt={image.name ?? undefined}
                                    width={450}
                                    placeholder="empty"
                                    style={{ width: '100%', zIndex: 2, position: 'relative' }}
                                  />
                                )}
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
                                </div>
                              </>
                            </RoutedContextLink>
                          </div>
                        </>
                      )}
                    </ImageGuard.Content>
                  )}
                />
              ) : (
                <Carousel
                  key={cardWidth}
                  withControls
                  draggable
                  loop
                  style={{ height: imageHeight }}
                  withIndicators
                  controlSize={32}
                  styles={{
                    indicators: {
                      bottom: 50,
                      zIndex: 15,
                    },
                    indicator: {
                      width: 8,
                      height: 8,
                      transition: 'width 250ms ease',
                    },
                  }}
                >
                  <ImageGuard
                    images={data.images}
                    connect={postId ? { entityType: 'post', entityId: postId } : undefined}
                    render={(image) => (
                      <Carousel.Slide style={{ height: imageHeight }} className={classes.slide}>
                        <ImageGuard.Content>
                          {({ safe }) => (
                            <>
                              <div className={classes.imageContainer}>
                                <ImageGuard.Report />
                                <ImageGuard.ToggleConnect
                                  sx={(theme) => ({
                                    backgroundColor: theme.fn.rgba(theme.colors.red[9], 0.4),
                                    color: 'white',
                                    backdropFilter: 'blur(7px)',
                                    boxShadow: '1px 2px 3px -1px rgba(37,38,43,0.2)',
                                  })}
                                />
                                <RoutedContextLink
                                  modal="imageDetailModal"
                                  imageId={image.id}
                                  modelId={modelId}
                                  postId={postId}
                                  username={username}
                                  onClick={handleClick}
                                  className={classes.link}
                                >
                                  <>
                                    {!safe ? (
                                      <AspectRatio
                                        ratio={(image?.width ?? 1) / (image?.height ?? 1)}
                                        sx={{ width: '100%' }}
                                      >
                                        <MediaHash {...image} />
                                      </AspectRatio>
                                    ) : (
                                      <EdgeImage
                                        src={image.url}
                                        name={image.name ?? image.id.toString()}
                                        alt={image.name ?? undefined}
                                        width={450}
                                        placeholder="empty"
                                        style={{ width: '100%', zIndex: 2, position: 'relative' }}
                                      />
                                    )}
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
                                </RoutedContextLink>
                              </div>
                            </>
                          )}
                        </ImageGuard.Content>
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
    paddingBottom: 42,
    background: theme.colors.dark[9],
    flexDirection: 'column',
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
  basicIndicator: {
    position: 'absolute',
    top: theme.spacing.xs,
    right: theme.spacing.xs,
    zIndex: 10,
    background: theme.fn.rgba(theme.colorScheme === 'dark' ? '#000' : '#fff', 0.75),
    padding: `0 ${theme.spacing.xs}px`,
    borderRadius: theme.radius.sm,
  },
}));
