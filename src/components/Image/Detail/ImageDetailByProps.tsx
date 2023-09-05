import {
  ActionIcon,
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
  IconDotsVertical,
  IconAlertTriangle,
  IconEye,
  IconPlaylistAdd,
  IconChevronLeft,
  IconChevronRight,
} from '@tabler/icons-react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Reactions } from '~/components/Reaction/Reactions';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { ImageDetailContextMenu } from '~/components/Image/Detail/ImageDetailContextMenu';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { ImageDetailComments } from '~/components/Image/Detail/ImageDetailComments';
import { ImageResources } from '~/components/Image/Detail/ImageResources';
import { Meta } from '~/components/Meta/Meta';
import { TrackView } from '~/components/TrackView/TrackView';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { CollectionType } from '@prisma/client';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { openContext } from '~/providers/CustomModalsProvider';
import { trpc } from '~/utils/trpc';
import { useHotkeys } from '@mantine/hooks';
import { useAspectRatioFit } from '~/hooks/useAspectRatioFit';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { ImageGetById } from '~/types/router';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';

export function ImageDetailByProps({
  imageId,
  onClose,
  onSetImage,
  nextImageId,
  prevImageId,
}: {
  imageId: number;
  onClose: () => void;
  nextImageId: number | null;
  prevImageId: number | null;
  onSetImage: (id: number | null) => void;
}) {
  const { data: image = null, isLoading } = trpc.image.get.useQuery(
    {
      id: imageId,
      withoutPost: true,
    },
    {
      enabled: !!imageId,
    }
  );

  const { classes, cx, theme } = useStyles();

  return (
    <>
      <Meta
        title={image ? `Image posted by ${image.user.username}` : 'Loading image...'}
        image={!image || image.url == null ? undefined : getEdgeUrl(image.url, { width: 1200 })}
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
          />
          <Card className={cx(classes.sidebar)}>
            {isLoading || !image ? (
              <Center>
                <Loader variant="bars" />
              </Center>
            ) : (
              <>
                <Card.Section py="xs" withBorder inheritPadding>
                  <Group position="apart" spacing={8} noWrap>
                    <UserAvatar
                      user={image.user}
                      avatarProps={{ size: 32 }}
                      size="sm"
                      subText={
                        <Text size="xs" color="dimmed">
                          Uploaded <DaysFromNow date={image.createdAt} />
                        </Text>
                      }
                      subTextForce
                      withUsername
                      linkToProfile
                    />
                    <Group spacing="md">
                      <FollowUserButton userId={image.user.id} size="md" compact />
                      <CloseButton
                        size="md"
                        radius="xl"
                        variant="transparent"
                        iconSize={20}
                        onClick={onClose}
                      />
                    </Group>
                  </Group>
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
                        <RoutedContextLink modal="postDetailModal" postId={image.postId}>
                          <Button
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
                        </RoutedContextLink>
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
                          <IconPlaylistAdd size={14} />
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
                      canAdd
                      canAddModerated={false}
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
                            reactions={image.reactions}
                            metrics={{
                              likeCount: image.stats?.likeCountAllTime,
                              dislikeCount: image.stats?.dislikeCountAllTime,
                              heartCount: image.stats?.heartCountAllTime,
                              laughCount: image.stats?.laughCountAllTime,
                              cryCount: image.stats?.cryCountAllTime,
                            }}
                          />
                          <ImageDetailComments imageId={image.id} userId={image.user.id} />
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
  const isMobile = `@media (max-width: ${theme.breakpoints.md - 1}px)`;
  const isDesktop = `@media (min-width: ${theme.breakpoints.md}px)`;
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
  image: ImageGetById | null;
  className?: string;
  nextImageId: number | null;
  prevImageId: number | null;
  onSetImage: (id: number | null) => void;
};

export function ImageDetailCarousel({
  image: current,
  className,
  nextImageId,
  prevImageId,
  onSetImage,
  isLoading,
}: GalleryCarouselProps) {
  // const router = useRouter();
  const { classes, cx } = useCarrouselStyles();

  const { setRef, height, width } = useAspectRatioFit({
    height: current?.height ?? 1200,
    width: current?.width ?? 1200,
  });

  // #region [navigation]
  useHotkeys([
    ['ArrowLeft', () => onSetImage(prevImageId)],
    ['ArrowRight', () => onSetImage(nextImageId)],
  ]);
  // #endregion

  if (!current) return null;

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
      {isLoading ? (
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
        <ImageGuard
          images={[current]}
          connect={{ entityId: current.postId, entityType: 'post' }}
          render={(image) => {
            return (
              <Center
                sx={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                }}
              >
                <Center
                  style={{
                    position: 'relative',
                    height: height,
                    width: width,
                  }}
                >
                  <ImageGuard.ToggleConnect
                    position="top-left"
                    sx={(theme) => ({ borderRadius: theme.radius.sm })}
                  />
                  <ImageGuard.ToggleImage
                    position="top-left"
                    sx={(theme) => ({ borderRadius: theme.radius.sm })}
                  />
                  <ImageGuard.Report />
                  <ImageGuard.Unsafe>
                    <MediaHash {...image} />
                  </ImageGuard.Unsafe>
                  <ImageGuard.Safe>
                    <EdgeMedia
                      src={image.url}
                      name={image.name ?? image.id.toString()}
                      alt={image.name ?? undefined}
                      type={image.type}
                      style={{ maxHeight: '100%', maxWidth: '100%' }}
                      width={image.width ?? 1200}
                      anim
                    />
                  </ImageGuard.Safe>
                </Center>
              </Center>
            );
          }}
        />
      )}
    </div>
  );
}

const useCarrouselStyles = createStyles((theme, _props, getRef) => {
  return {
    root: {
      position: 'relative',
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
