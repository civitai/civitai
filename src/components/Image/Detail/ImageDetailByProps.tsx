import {
  Box,
  Button,
  Card,
  Center,
  CloseButton,
  createStyles,
  Divider,
  Group,
  Loader,
  MantineProvider,
  Paper,
  ScrollArea,
  Stack,
  Text,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconEye,
  IconBookmark,
  IconChevronLeft,
  IconChevronRight,
} from '@tabler/icons-react';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { Reactions } from '~/components/Reaction/Reactions';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { ImageDetailComments } from '~/components/Image/Detail/ImageDetailComments';
import { ImageResources } from '~/components/Image/Detail/ImageResources';
import { Meta } from '~/components/Meta/Meta';
import { TrackView } from '~/components/TrackView/TrackView';
import { CollectionType } from '~/shared/utils/prisma/enums';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { openContext } from '~/providers/CustomModalsProvider';
import { trpc } from '~/utils/trpc';
import { useDidUpdate, useHotkeys } from '@mantine/hooks';
import { useAspectRatioFit } from '~/hooks/useAspectRatioFit';
import { ImageGuardConnect } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageProps } from '~/components/ImageViewer/ImageViewer';
import React from 'react';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { truncate } from 'lodash-es';
import { constants } from '~/server/common/constants';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { useIsMutating } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';

export function ImageDetailByProps({
  imageId,
  onClose,
  onSetImage,
  nextImageId,
  prevImageId,
  image: defaultImageItem,
  connectId,
  connectType,
}: {
  imageId: number;
  onClose: () => void;
  nextImageId: number | null;
  prevImageId: number | null;
  onSetImage: (id: number | null) => void;
  image?: ImageProps | null;
} & Partial<ImageGuardConnect>) {
  const { data = null, isLoading } = trpc.image.get.useQuery(
    { id: imageId, withoutPost: true },
    { enabled: !!imageId }
  );

  const image = data || defaultImageItem || null;
  const reactions = data?.reactions ?? [];
  const stats: {
    likeCountAllTime: number;
    dislikeCountAllTime: number;
    heartCountAllTime: number;
    laughCountAllTime: number;
    cryCountAllTime: number;
  } | null = data?.stats ?? null;

  const user = data?.user;
  const { classes, cx, theme } = useStyles();

  const nsfw = image ? !getIsSafeBrowsingLevel(image.nsfwLevel) : false;

  return (
    <>
      <Meta
        title={image ? `Image posted by ${user?.username}` : 'Loading image...'}
        images={image}
        deIndex={nsfw || (image ? !!image.needsReview : false)}
      />
      {image && <TrackView entityId={image.id} entityType="Image" type="ImageView" />}
      <MantineProvider theme={{ colorScheme: 'dark' }}>
        <Paper className={classes.root}>
          <CloseButton
            style={{ position: 'absolute', top: 15, right: 15, zIndex: 10 }}
            size="lg"
            variant="default"
            onClick={onClose}
            className={classes.mobileOnly}
          />
          <ImageDetailCarousel
            image={image}
            className={classes.carousel}
            onSetImage={onSetImage}
            nextImageId={nextImageId}
            prevImageId={prevImageId}
            isLoading={isLoading}
            connectId={connectId}
            connectType={connectType}
            onClose={onClose}
          />
          <Card className={cx(classes.sidebar)}>
            {!image ? (
              <Center>
                <Loader variant="bars" />
              </Center>
            ) : (
              <>
                <Card.Section py="xs" withBorder inheritPadding>
                  {!user ? (
                    <Center>
                      <Loader variant="bars" />
                    </Center>
                  ) : (
                    <Group position="apart" spacing={8} noWrap>
                      <UserAvatar
                        user={user}
                        avatarProps={{ size: 32 }}
                        size="sm"
                        subText={
                          <>
                            {image.publishedAt || image.createdAt ? (
                              <Text size="xs" color="dimmed">
                                Uploaded <DaysFromNow date={image.publishedAt || image.createdAt} />
                              </Text>
                            ) : (
                              'Not Published'
                            )}
                          </>
                        }
                        subTextForce
                        withUsername
                        linkToProfile
                      />
                      <Group spacing="md">
                        <FollowUserButton userId={user.id} size="md" compact />
                        <CloseButton
                          size="md"
                          radius="xl"
                          variant="transparent"
                          iconSize={20}
                          onClick={onClose}
                        />
                      </Group>
                    </Group>
                  )}
                </Card.Section>
                <Card.Section
                  py="xs"
                  sx={{ backgroundColor: theme.colors.dark[7] }}
                  withBorder
                  inheritPadding
                >
                  <Group position="apart" spacing={8}>
                    <Group spacing={8}>
                      {image.postId && (
                        <RoutedDialogLink
                          passHref
                          name="postDetail"
                          state={{ postId: image.postId }}
                        >
                          <Button
                            component="a"
                            size="md"
                            radius="xl"
                            color="gray"
                            variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                            compact
                          >
                            <Group spacing={4}>
                              <IconEye size={14} />
                              <Text size="xs">View post</Text>
                            </Group>
                          </Button>
                        </RoutedDialogLink>
                      )}
                      <Button
                        size="md"
                        radius="xl"
                        color="gray"
                        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                        onClick={() =>
                          openContext('addToCollection', {
                            imageId: image.id,
                            type: CollectionType.Image,
                          })
                        }
                        compact
                      >
                        <Group spacing={4}>
                          <IconBookmark size={14} />
                          <Text size="xs">Save</Text>
                        </Group>
                      </Button>
                    </Group>
                  </Group>
                </Card.Section>
                <Card.Section
                  component={ScrollArea}
                  style={{ flex: 1, position: 'relative' }}
                  classNames={{ viewport: classes.scrollViewport }}
                >
                  <Stack spacing="md" pt={image.needsReview ? 0 : 'md'} pb="md" style={{ flex: 1 }}>
                    {image.needsReview && (
                      <AlertWithIcon
                        icon={<IconAlertTriangle />}
                        color="yellow"
                        iconColor="yellow"
                        title="Flagged for review"
                        radius={0}
                        px="md"
                      >
                        {`This image won't be visible to other users until it's reviewed by our moderators.`}
                      </AlertWithIcon>
                    )}
                    <VotableTags
                      entityType="image"
                      entityId={image.id}
                      nsfwLevel={image.nsfwLevel}
                      canAdd
                      collapsible
                      px="sm"
                    />
                    <div>
                      <Divider
                        label="Discussion"
                        labelPosition="center"
                        styles={{
                          label: {
                            marginTop: '-9px !important',
                            marginBottom: -9,
                          },
                        }}
                      />
                      <Paper p="sm" radius={0}>
                        <Stack spacing={8}>
                          <Reactions
                            entityId={image.id}
                            entityType="image"
                            reactions={reactions}
                            metrics={{
                              likeCount: stats?.likeCountAllTime,
                              dislikeCount: stats?.dislikeCountAllTime,
                              heartCount: stats?.heartCountAllTime,
                              laughCount: stats?.laughCountAllTime,
                              cryCount: stats?.cryCountAllTime,
                            }}
                            targetUserId={user?.id}
                          />
                          {user?.id && <ImageDetailComments imageId={image.id} userId={user.id} />}
                        </Stack>
                      </Paper>
                    </div>
                    <Stack spacing="md" mt="auto">
                      <Divider label="Resources Used" labelPosition="center" />

                      <Box px="md">
                        <ImageResources imageId={image.id} />
                      </Box>
                    </Stack>
                  </Stack>
                </Card.Section>
              </>
            )}
          </Card>
        </Paper>
      </MantineProvider>
    </>
  );
}

const useStyles = createStyles((theme, _props, getRef) => {
  const isMobile = theme.fn.smallerThan('md');
  const isDesktop = theme.fn.largerThan('md');
  return {
    root: {
      width: '100vw',
      height: '100vh',
      display: 'flex',
      position: 'relative',
      overflow: 'hidden',
    },
    carousel: {
      flex: 1,
      alignItems: 'stretch',
    },
    active: { ref: getRef('active') },
    sidebar: {
      width: 457,
      borderRadius: 0,
      borderLeft: `1px solid ${theme.colors.dark[4]}`,
      display: 'flex',
      flexDirection: 'column',

      [isMobile]: {
        position: 'absolute',
        top: '100%',
        left: 0,
        width: '100%',
        height: '100%',
        transition: '.3s ease transform',
        // transform: 'translateY(100%)',
        zIndex: 20,

        [`&.${getRef('active')}`]: {
          transform: 'translateY(-100%)',
        },
      },
    },
    mobileOnly: { [isDesktop]: { display: 'none' } },
    desktopOnly: { [isMobile]: { display: 'none' } },
    info: {
      position: 'absolute',
      bottom: theme.spacing.md,
      right: theme.spacing.md,
    },
    // Overwrite scrollArea generated styles
    scrollViewport: {
      '& > div': {
        minHeight: '100%',
        display: 'flex !important',
      },
    },
  };
});

type GalleryCarouselProps = {
  isLoading: boolean;
  image: ImageProps | null;
  className?: string;
  nextImageId: number | null;
  prevImageId: number | null;
  onSetImage: (id: number | null) => void;
  onClose: () => void;
};

export function ImageDetailCarousel({
  image: image,
  className,
  nextImageId,
  prevImageId,
  onSetImage,
  isLoading,
  connectId,
  connectType = 'post',
  onClose,
}: GalleryCarouselProps & Partial<ImageGuardConnect>) {
  const { classes, cx } = useCarrouselStyles();

  const { setRef, height, width } = useAspectRatioFit({
    height: image?.height ?? 1200,
    width: image?.width ?? 1200,
  });
  const isDeletingImage = !!useIsMutating(getQueryKey(trpc.image.delete));

  useDidUpdate(() => {
    if (!isDeletingImage) {
      onClose();
    }
  }, [isDeletingImage]);

  // #region [navigation]
  useHotkeys([
    ['ArrowLeft', () => onSetImage(prevImageId)],
    ['ArrowRight', () => onSetImage(nextImageId)],
  ]);
  // #endregion

  if (!image) return null;

  const canNavigate = nextImageId || prevImageId;

  return (
    <div ref={setRef} className={cx(classes.root, className)}>
      {canNavigate && (
        <>
          {!!prevImageId && (
            <UnstyledButton
              className={cx(classes.control, classes.prev)}
              onClick={() => onSetImage(prevImageId)}
            >
              <IconChevronLeft />
            </UnstyledButton>
          )}
          {!!nextImageId && (
            <UnstyledButton
              className={cx(classes.control, classes.next)}
              onClick={() => onSetImage(nextImageId)}
            >
              <IconChevronRight />
            </UnstyledButton>
          )}
        </>
      )}
      {isLoading && !image ? (
        <Center
          style={{
            position: 'relative',
            height: height,
            width: width,
          }}
        >
          <Loader />
        </Center>
      ) : (
        image && (
          <ImageGuard2
            image={image}
            connectId={connectId || image?.postId || -1}
            connectType={connectType}
          >
            {(safe) => (
              <Center
                sx={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  opacity: isDeletingImage ? 0.5 : 1,
                }}
              >
                <Center
                  style={{
                    position: 'relative',
                    height: height,
                    width: width,
                  }}
                >
                  <ImageGuard2.BlurToggle radius="sm" className="absolute left-2 top-2 z-10" />
                  <ImageContextMenu image={image} className="absolute right-2 top-2 z-10" />
                  {!safe ? (
                    <MediaHash {...image} />
                  ) : (
                    <EdgeMedia
                      src={image.url}
                      name={image.name ?? image.id.toString()}
                      alt={image.name ?? undefined}
                      type={image.type}
                      style={{ maxHeight: '100%', maxWidth: '100%' }}
                      anim
                    />
                  )}
                </Center>
              </Center>
            )}
          </ImageGuard2>
        )
      )}
      {isDeletingImage && (
        <Box className={classes.loader}>
          <Center>
            <Loader />
          </Center>
        </Box>
      )}
    </div>
  );
}

const useCarrouselStyles = createStyles((theme, _props, getRef) => {
  return {
    root: {
      position: 'relative',
    },
    loader: {
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%,-50%)',
      zIndex: 1,
    },
    imageLoading: {
      pointerEvents: 'none',
      opacity: 0.5,
    },
    center: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
    },

    prev: { ref: getRef('prev') },
    next: { ref: getRef('next') },
    control: {
      position: 'absolute',
      // top: 0,
      // bottom: 0,
      top: '50%',
      transform: 'translateY(-50%)',
      zIndex: 10,

      svg: {
        height: 50,
        width: 50,
      },

      [`&.${getRef('prev')}`]: {
        left: 0,
      },
      [`&.${getRef('next')}`]: {
        right: 0,
      },

      '&:hover': {
        color: theme.colors.blue[3],
      },
    },
    indicators: {
      position: 'absolute',
      bottom: theme.spacing.md,
      top: undefined,
      left: 0,
      right: 0,
      display: 'flex',
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 8,
      pointerEvents: 'none',
    },

    indicator: {
      pointerEvents: 'all',
      width: 25,
      height: 5,
      borderRadius: 10000,
      backgroundColor: theme.white,
      boxShadow: theme.shadows.sm,
      opacity: 0.6,
      transition: `opacity 150ms ${theme.transitionTimingFunction}`,

      '&[data-active]': {
        opacity: 1,
      },
    },
  };
});
