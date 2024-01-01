import { Carousel, Embla } from '@mantine/carousel';
import { ActionIcon, Center, Group, Menu, Paper, Text, Tooltip, createStyles } from '@mantine/core';
import { IconExclamationMark, IconInfoCircle, IconMessage } from '@tabler/icons-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import { useImagesAsPostsInfiniteContext } from '~/components/Image/AsPosts/ImagesAsPostsInfinite';
import { useModelGallerySettings } from '~/components/Image/AsPosts/gallery.utils';
import { OnsiteIndicator } from '~/components/Image/Indicators/OnsiteIndicator';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { MasonryCard } from '~/components/MasonryGrid/MasonryCard';
import { Reactions } from '~/components/Reaction/Reactions';
import { StarRating } from '~/components/StartRating/StarRating';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useInView } from '~/hooks/useInView';
import { ImagesAsPostModel } from '~/server/controllers/image.controller';

export function ImagesAsPostsCard({
  data,
  width: cardWidth,
  height,
}: {
  data: ImagesAsPostModel;
  width: number;
  height: number;
}) {
  const { ref, inView } = useInView({ rootMargin: '200%' });
  const { classes } = useStyles();
  const currentUser = useCurrentUser();

  const { modelVersions, showModerationOptions, model } = useImagesAsPostsInfiniteContext();
  const targetModelVersion = modelVersions?.find((x) => x.id === data.modelVersionId);
  const modelVersionName = targetModelVersion?.name;
  const postId = data.postId ?? undefined;

  const cover = data.images[0];
  const carouselHeight = height - 58 - 8;

  const [embla, setEmbla] = useState<Embla | null>(null);
  const [slidesInView, setSlidesInView] = useState<number[]>([]);

  const { hiddenImages, toggleGallerySettings } = useModelGallerySettings({
    modelId: model.id,
  });
  const handleUpdateGallerySettings = async (imageId: number) => {
    if (showModerationOptions && model) {
      await toggleGallerySettings({
        modelId: model.id,
        images: [{ id: imageId }],
      }).catch(() => null); // Error is handled in the mutation events
    }
  };

  useEffect(() => {
    if (!embla) return;
    setSlidesInView(embla.slidesInView(true));
    const onSelect = () => setSlidesInView([...embla.slidesInView(true), ...embla.slidesInView()]);
    embla.on('select', onSelect);
    return () => {
      embla.off('select', onSelect);
    };
  }, [embla]);

  const imageIdsString = data.images.map((x) => x.id).join('_');
  const carouselKey = useMemo(() => `${imageIdsString}_${cardWidth}`, [imageIdsString, cardWidth]);

  const moderationOptions = (imageId: number) => {
    if (!showModerationOptions) return null;
    const alreadyHidden = hiddenImages.get(imageId);

    return [
      <Menu.Divider key="menu-divider" />,
      <Menu.Label key="menu-label">Moderation zone</Menu.Label>,
      // TODO.manuel: move this to its own component
      <Menu.Item key="hide-image-gallery" onClick={() => handleUpdateGallerySettings(imageId)}>
        {alreadyHidden ? 'Unhide image from gallery' : 'Hide image from gallery'}
      </Menu.Item>,
    ];
  };

  return (
    <MasonryCard withBorder shadow="sm" p={0} height={height} ref={ref} className={classes.card}>
      <Paper radius={0} h={58}>
        {inView && (
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
                  <Link href={`/posts/${data.postId}/edit`}>
                    <ActionIcon color="red" variant="outline">
                      <IconExclamationMark />
                    </ActionIcon>
                  </Link>
                </Tooltip>
              )}
              {data.review ? (
                <RoutedDialogLink name="resourceReview" state={{ reviewId: data.review.id }}>
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
                </RoutedDialogLink>
              ) : currentUser?.id === data.user.id ? (
                <>{/* <Button compact>Add Review</Button> */}</>
              ) : null}
            </Group>
          </Group>
        )}
      </Paper>
      <div className={classes.container}>
        <div className={classes.blurHash}>
          <MediaHash {...data.images[0]} />
        </div>
        <div className={classes.content} style={{ opacity: inView ? 1 : 0 }}>
          {inView && (
            <>
              {data.images.length === 1 ? (
                <ImageGuard
                  images={[cover]}
                  render={(image) => (
                    <ImageGuard.Content>
                      {({ safe }) => (
                        <div className={classes.imageContainer}>
                          {image.meta && 'civitaiResources' in (image.meta as object) && (
                            <OnsiteIndicator />
                          )}
                          <ImageGuard.Report additionalMenuItems={moderationOptions(image.id)} />
                          <ImageGuard.ToggleImage position="top-left" />
                          <RoutedDialogLink
                            name="imageDetail"
                            state={{ imageId: image.id, images: [image] }}
                            className={classes.link}
                          >
                            <>
                              {safe && (
                                <EdgeMedia
                                  src={image.url}
                                  name={image.name ?? image.id.toString()}
                                  alt={image.name ?? undefined}
                                  type={image.type}
                                  width={450}
                                  placeholder="empty"
                                  className={classes.image}
                                  wrapperProps={{ style: { zIndex: 1 } }}
                                  fadeIn
                                />
                              )}
                            </>
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
                      bottom: -8,
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
                      <Carousel.Slide className={classes.slide}>
                        {slidesInView.includes(index) && (
                          <ImageGuard.Content>
                            {({ safe }) => (
                              <div className={classes.imageContainer}>
                                {image.meta && 'civitaiResources' in (image.meta as object) && (
                                  <OnsiteIndicator />
                                )}
                                <ImageGuard.Report
                                  additionalMenuItems={moderationOptions(image.id)}
                                />
                                <ImageGuard.ToggleConnect position="top-left" />
                                <RoutedDialogLink
                                  name="imageDetail"
                                  state={{ imageId: image.id, images: data.images }}
                                  className={classes.link}
                                >
                                  <>
                                    <div className={classes.blurHash}>
                                      <MediaHash {...image} />
                                    </div>
                                    {safe && (
                                      <EdgeMedia
                                        src={image.url}
                                        name={image.name ?? image.id.toString()}
                                        alt={image.name ?? undefined}
                                        type={image.type}
                                        width={450}
                                        placeholder="empty"
                                        className={classes.image}
                                        wrapperProps={{ style: { zIndex: 1 } }}
                                        fadeIn
                                      />
                                    )}
                                  </>
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
                                    tippedAmountCount: image.stats?.tippedAmountCountAllTime,
                                  }}
                                  readonly={!safe}
                                  className={classes.reactions}
                                  targetUserId={image.user.id}
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
        </div>
      </div>
    </MasonryCard>
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
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    // paddingBottom: 42,
    // background: theme.colors.dark[9],
    flexDirection: 'column',
    overflow: 'hidden',
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
  blurHash: {
    opacity: 0.7,
    zIndex: 1,
  },
  container: {
    position: 'relative',
    flex: 1,
  },
  content: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    transition: theme.other.fadeIn,
    opacity: 0,
    zIndex: 2,
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
