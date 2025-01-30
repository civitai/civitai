import { Carousel, Embla } from '@mantine/carousel';
import {
  ActionIcon,
  Badge,
  createStyles,
  Group,
  HoverCard,
  Menu,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  ThemeIconProps,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import {
  IconAutomaticGearbox,
  IconBrush,
  IconExclamationMark,
  IconInfoCircle,
  IconMessage,
  IconPinFilled,
  IconPinned,
  IconPinnedOff,
  IconProps,
  IconUserPlus,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import { useGallerySettings } from '~/components/Image/AsPosts/gallery.utils';
import { useImagesAsPostsInfiniteContext } from '~/components/Image/AsPosts/ImagesAsPostsInfinite';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { OnsiteIndicator } from '~/components/Image/Indicators/OnsiteIndicator';
import { ImageMetaPopover2 } from '~/components/Image/Meta/ImageMetaPopover';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { Reactions } from '~/components/Reaction/Reactions';
import { ThumbsDownIcon, ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { TwCard } from '~/components/TwCard/TwCard';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useInView } from '~/hooks/useInView';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { ImagesAsPostModel } from '~/server/controllers/image.controller';
import { generationPanel } from '~/store/generation.store';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export function ImagesAsPostsCard({
  data,
  width: cardWidth,
  height,
}: {
  data: ImagesAsPostModel;
  width: number;
  height: number;
}) {
  const theme = useMantineTheme();
  const { classes, cx } = useStyles();
  const features = useFeatureFlags();
  const queryUtils = trpc.useUtils();

  const { modelVersions, showModerationOptions, model, filters } =
    useImagesAsPostsInfiniteContext();
  const targetModelVersion = modelVersions?.find((x) => x.id === data.modelVersionId);

  const postId = data.postId ?? undefined;
  const currentModelVersionId = filters.modelVersionId as number;

  const fromAutoResource =
    !targetModelVersion &&
    data.images.some((i) => i.modelVersionIds?.includes(currentModelVersionId));
  const fromManualResource =
    !targetModelVersion &&
    data.images.some((i) => i.modelVersionIdsManual?.includes(currentModelVersionId));

  const image = data.images[0];

  const [embla, setEmbla] = useState<Embla | null>(null);
  const [slidesInView, setSlidesInView] = useState<number[]>([]);

  const { gallerySettings, toggle } = useGallerySettings({ modelId: model.id });

  const handleUpdateGallerySettings = async ({
    imageId,
    user,
  }: {
    imageId?: number;
    user?: { id: number; username: string | null };
  }) => {
    if (showModerationOptions && model) {
      await toggle({
        modelId: model.id,
        images: imageId ? [{ id: imageId }] : undefined,
        users: user ? [user] : undefined,
      }).catch(() => null); // Error is handled in the mutation events

      if (filters.hidden)
        // Refetch the query to update the hidden images
        await queryUtils.image.getImagesAsPostsInfinite.invalidate({ ...filters });
    }
  };

  const handlePinPost = async ({
    postId,
    alreadyPinned,
  }: {
    postId: number;
    alreadyPinned: boolean;
  }) => {
    if (model) {
      try {
        await toggle({
          modelId: model.id,
          pinnedPosts: { modelVersionId: currentModelVersionId, postIds: [postId] },
        });

        showSuccessNotification({
          title: alreadyPinned ? 'Post unpinned' : 'Post pinned',
          message: alreadyPinned
            ? 'This post has been removed from the top of the gallery'
            : 'This post has been pinned and will appear at the top of the gallery for new visitors',
        });
      } catch (error) {
        // Error is handled in the mutation events
        return null;
      }
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

  const moderationOptions = (image: (typeof data.images)[number]) => {
    if (!showModerationOptions) return null;
    const imageAlreadyHidden = gallerySettings
      ? gallerySettings.hiddenImages.indexOf(image.id) > -1
      : false;
    const userAlreadyHidden = gallerySettings
      ? gallerySettings.hiddenUsers.findIndex((u) => u.id === image.user.id) > -1
      : false;
    const alreadyPinned =
      gallerySettings && image.postId
        ? gallerySettings.pinnedPosts?.[currentModelVersionId]?.includes(image.postId)
        : false;
    const maxedOut = gallerySettings
      ? (gallerySettings.pinnedPosts?.[currentModelVersionId]?.length ?? 0) >=
        constants.modelGallery.maxPinnedPosts
      : false;

    return (
      <>
        <Menu.Label key="menu-label">Gallery Moderation</Menu.Label>
        {image.postId ? (
          <Menu.Item
            key="pin-post"
            icon={
              alreadyPinned ? (
                <IconPinnedOff size={16} stroke={1.5} />
              ) : (
                <IconPinned size={16} stroke={1.5} />
              )
            }
            sx={{ alignItems: maxedOut ? 'flex-start' : 'center' }}
            disabled={!alreadyPinned && maxedOut}
            onClick={() => handlePinPost({ postId: image.postId as number, alreadyPinned })}
          >
            {alreadyPinned ? (
              'Unpin this post'
            ) : (
              <Stack spacing={2}>
                <Text inline>Pin this post</Text>
                {maxedOut && (
                  <Text size="xs" color="yellow">
                    Pin limit reached
                  </Text>
                )}
              </Stack>
            )}
          </Menu.Item>
        ) : null}
        <Menu.Item
          key="hide-image-gallery"
          onClick={() => handleUpdateGallerySettings({ imageId: image.id })}
        >
          {imageAlreadyHidden ? 'Unhide image from gallery' : 'Hide image from gallery'}
        </Menu.Item>
        <Menu.Item
          key="hide-user-gallery"
          onClick={() => handleUpdateGallerySettings({ user: image.user })}
        >
          {userAlreadyHidden ? 'Show content from this user' : 'Hide content from this user'}
        </Menu.Item>
      </>
    );
  };

  const isThumbsUp = !!data.review?.recommended;
  const pinned = gallerySettings
    ? gallerySettings.pinnedPosts?.[currentModelVersionId]?.includes(data.postId)
    : false;
  const isOP = data.user.id === model?.user.id;
  const carouselHeight = height - 58 - 8 - (pinned ? 0 : 0);

  const cosmetic = data.images.find((i) => isDefined(i.cosmetic))?.cosmetic;
  const cosmeticData =
    cosmetic?.data || pinned
      ? {
          ...cosmetic?.data,
          ...(pinned
            ? {
                border: theme.colors.orange[theme.fn.primaryShade()],
                borderWidth: 2,
              }
            : undefined),
        }
      : undefined;

  const { ref, inView } = useInView({ key: cosmeticData ? 1 : 0 });

  return (
    <TwCosmeticWrapper
      className="w-full"
      cosmetic={cosmeticData}
      style={cosmeticData ? { height } : undefined}
    >
      <>
        {pinned && (
          <PinnedIndicator
            radius="xl"
            color="orange"
            size="md"
            iconProps={{ size: 16, stroke: 1.5 }}
          />
        )}
        <TwCard
          style={!cosmeticData ? { height } : undefined}
          className={cx({ ['border']: !pinned })}
          ref={ref}
        >
          <MediaHash {...image} className={cx('opacity-70', cosmetic && 'rounded-b-lg')} />
          {data.user.id !== -1 && (
            <Paper p="xs" radius={0} className={cx('h-[58px] z-[2]', cosmetic && 'rounded-t-lg ')}>
              {inView && (
                <Group spacing={8} align="flex-start" position="apart" noWrap>
                  <UserAvatar
                    user={data.user}
                    subText={
                      <Group spacing="xs" noWrap>
                        {data.publishedAt ? (
                          <DaysFromNow date={data.publishedAt} />
                        ) : (
                          <Text>Not published</Text>
                        )}
                        {(fromAutoResource || fromManualResource) && (
                          <Group ml={6} spacing={4}>
                            {fromAutoResource && (
                              <Tooltip label="Auto-detected resource" withArrow>
                                <ThemeIcon color="teal" variant="light" radius="xl" size={18}>
                                  <IconAutomaticGearbox size={16} />
                                </ThemeIcon>
                              </Tooltip>
                            )}
                            {fromManualResource && (
                              <Tooltip label="Manually-added resource" withArrow>
                                <ThemeIcon color="cyan" variant="light" radius="xl" size={18}>
                                  <IconUserPlus size={16} />
                                </ThemeIcon>
                              </Tooltip>
                            )}
                          </Group>
                        )}
                      </Group>
                    }
                    subTextForce
                    size="md"
                    spacing="xs"
                    badge={
                      isOP ? (
                        <Badge size="xs" color="violet" radius="xl">
                          OP
                        </Badge>
                      ) : null
                    }
                    withUsername
                    linkToProfile
                  />
                  <Group spacing={8} position="right" noWrap>
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
                        <Badge
                          variant="light"
                          radius="md"
                          size="lg"
                          style={{ userSelect: 'none', padding: 4, height: 'auto' }}
                          color={isThumbsUp ? 'success.5' : 'red'}
                        >
                          <Group spacing={4} noWrap>
                            {isThumbsUp ? <ThumbsUpIcon filled /> : <ThumbsDownIcon filled />}
                            {data.review.details && <IconMessage size={18} strokeWidth={2.5} />}
                          </Group>
                        </Badge>
                      </RoutedDialogLink>
                    ) : null}
                  </Group>
                </Group>
              )}
            </Paper>
          )}

          <div
            className="relative flex-1 overflow-hidden opacity-0 transition-opacity"
            style={{ opacity: inView ? 1 : 0 }}
          >
            {inView && (
              <>
                {data.images.length === 1 ? (
                  <ImageGuard2 image={image}>
                    {(safe) => (
                      <>
                        {image.onSite && <OnsiteIndicator isRemix={!!image.remixOfId} />}
                        <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                        {safe && (
                          <Stack spacing="xs" className="absolute right-2 top-2 z-10">
                            <ImageContextMenu
                              image={image}
                              additionalMenuItems={moderationOptions(image)}
                            />
                            {features.imageGeneration &&
                              (image.hasPositivePrompt ?? image.hasMeta) && (
                                <HoverActionButton
                                  label="Remix"
                                  size={30}
                                  color="white"
                                  variant="filled"
                                  data-activity="remix:model-gallery"
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
                        )}
                        <RoutedDialogLink
                          name="imageDetail"
                          state={{ imageId: image.id, images: [image] }}
                          className={classes.link}
                        >
                          <>
                            {safe && (
                              <EdgeMedia2
                                metadata={image.metadata}
                                src={image.url}
                                thumbnailUrl={image.thumbnailUrl}
                                name={image.name ?? image.id.toString()}
                                alt={image.name ?? undefined}
                                type={image.type}
                                width={450}
                                placeholder="empty"
                                wrapperProps={{ style: { zIndex: 1 } }}
                                skip={getSkipValue(image)}
                                fadeIn
                                className="z-[1] object-cover"
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
                    {data.images.map((image, index) => {
                      return (
                        <Carousel.Slide key={image.id}>
                          {slidesInView.includes(index) && (
                            <ImageGuard2 image={image} connectType="post" connectId={postId}>
                              {(safe) => (
                                <>
                                  {image.onSite && <OnsiteIndicator isRemix={!!image.remixOfId} />}
                                  <ImageGuard2.BlurToggle className="absolute left-2 top-2 z-10" />
                                  {safe && (
                                    <Stack spacing="xs" className="absolute right-2 top-2 z-10">
                                      <ImageContextMenu
                                        image={image}
                                        additionalMenuItems={moderationOptions(image)}
                                      />
                                      {features.imageGeneration &&
                                        (image.hasPositivePrompt ?? image.hasMeta) && (
                                          <HoverActionButton
                                            label="Remix"
                                            size={30}
                                            color="white"
                                            variant="filled"
                                            data-activity="remix:model-gallery"
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
                                  )}
                                  <RoutedDialogLink
                                    name="imageDetail"
                                    state={{ imageId: image.id, images: data.images }}
                                    className={classes.link}
                                  >
                                    <>
                                      <MediaHash {...image} className="opacity-70" />

                                      {safe && (
                                        <EdgeMedia2
                                          metadata={image.metadata}
                                          src={image.url}
                                          thumbnailUrl={image.thumbnailUrl}
                                          name={image.name ?? image.id.toString()}
                                          alt={image.name ?? undefined}
                                          type={image.type}
                                          width={450}
                                          placeholder="empty"
                                          wrapperProps={{ style: { zIndex: 1 } }}
                                          skip={getSkipValue(image)}
                                          fadeIn
                                          className="z-[1] object-cover"
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
                          )}
                        </Carousel.Slide>
                      );
                    })}
                  </Carousel>
                )}
              </>
            )}
          </div>
        </TwCard>
      </>
    </TwCosmeticWrapper>
  );
}

function PinnedIndicator({
  iconProps,
  className,
  ...themeIconProps
}: Omit<ThemeIconProps, 'children'> & { iconProps?: IconProps }) {
  return (
    <HoverCard width={300} withArrow withinPortal>
      <HoverCard.Target>
        <ThemeIcon {...themeIconProps} className="absolute -right-2.5 -top-2.5 z-10">
          <IconPinFilled {...iconProps} />
        </ThemeIcon>
      </HoverCard.Target>
      <HoverCard.Dropdown px="md" py={8}>
        <Text size="sm" weight={600} color="white">
          Pinned Post
        </Text>
        <Text size="xs">
          The creator of this post has pinned this because it is an excellent showcase of the
          resource&apos;s ability
        </Text>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

const useStyles = createStyles((theme) => ({
  title: {
    lineHeight: 1.1,
    fontSize: 14,
    color: 'white',
    fontWeight: 500,
  },
  link: {
    width: '100%',
    height: '100%',
    display: 'flex',
    justifyContent: 'center',
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
    zIndex: 1,
  },
}));
