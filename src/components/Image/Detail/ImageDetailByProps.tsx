import {
  Box,
  Button,
  Card,
  Center,
  CloseButton,
  ColorSchemeScript,
  Divider,
  Group,
  Loader,
  MantineProvider,
  Paper,
  ScrollArea,
  Stack,
  Text,
  UnstyledButton,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { useDidUpdate, useHotkeys } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconBookmark,
  IconChevronLeft,
  IconChevronRight,
  IconEye,
} from '@tabler/icons-react';
import { useIsMutating } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import React from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { openAddToCollectionModal } from '~/components/Dialog/triggers/add-to-collection';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { ImageContextMenu } from '~/components/Image/ContextMenu/ImageContextMenu';
import { ImageDetailComments } from '~/components/Image/Detail/ImageDetailComments';
import { ImageResources } from '~/components/Image/Detail/ImageResources';
import type { ImageGuardConnect } from '~/components/ImageGuard/ImageGuard2';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { ImageProps } from '~/components/ImageViewer/ImageViewer';
import { Meta } from '~/components/Meta/Meta';
import { NextLink } from '~/components/NextLink/NextLink';
import { MetricSubscriptionProvider, useLiveMetrics } from '~/components/Metrics';
import { Reactions } from '~/components/Reaction/Reactions';
import { TrackView } from '~/components/TrackView/TrackView';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { useAspectRatioFit } from '~/hooks/useAspectRatioFit';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { CollectionType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';
import { Notifications } from '@mantine/notifications';
import classes from './ImageDetailByProps.module.scss';
import clsx from 'clsx';

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
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  const nsfw = image ? !getIsSafeBrowsingLevel(image.nsfwLevel) : false;

  return (
    <>
      <Meta
        title={image ? `Image posted by ${user?.username}` : 'Loading image...'}
        images={image}
        deIndex={nsfw || (image ? !!image.needsReview : false)}
      />
      {image && <TrackView entityId={image.id} entityType="Image" type="ImageView" />}
      <Notifications />
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
        <Card className={clsx(classes.sidebar)}>
          {!image ? (
            <Center>
              <Loader type="bars" />
            </Center>
          ) : (
            <>
              <Card.Section py="xs" withBorder inheritPadding>
                {!user ? (
                  <Center>
                    <Loader type="bars" />
                  </Center>
                ) : (
                  <Group justify="space-between" gap={8} wrap="nowrap">
                    <UserAvatar
                      user={user}
                      avatarProps={{ size: 32 }}
                      size="sm"
                      subText={
                        <>
                          {image.publishedAt || image.createdAt ? (
                            <Text size="xs" c="dimmed">
                              Uploaded{' '}
                              <DaysFromNow
                                date={Math.max(
                                  image.publishedAt?.getTime() ?? 0,
                                  image.createdAt?.getTime() ?? 0
                                )}
                              />
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
                    <Group gap="md">
                      <FollowUserButton userId={user.id} size="compact-sm" />
                      <CloseButton
                        size="md"
                        radius="xl"
                        variant="transparent"
                        className={classes.desktopOnly}
                        iconSize={20}
                        onClick={onClose}
                      />
                    </Group>
                  </Group>
                )}
              </Card.Section>
              <Card.Section py="xs" className="bg-gray-1 dark:bg-dark-7" withBorder inheritPadding>
                <Group justify="space-between" gap={8}>
                  <Group gap={8}>
                    {image.postId && (
                      <Button
                        component={NextLink}
                        href={`/posts/${image.postId}`}
                        radius="xl"
                        color="gray"
                        variant={colorScheme === 'dark' ? 'filled' : 'light'}
                        size="compact-sm"
                      >
                        <Group gap={4}>
                          <IconEye size={14} />
                          <Text size="xs">View post</Text>
                        </Group>
                      </Button>
                    )}
                    <Button
                      radius="xl"
                      color="gray"
                      variant={colorScheme === 'dark' ? 'filled' : 'light'}
                      onClick={() =>
                        openAddToCollectionModal({
                          props: {
                            imageId: image.id,
                            type: CollectionType.Image,
                          },
                        })
                      }
                      size="compact-sm"
                    >
                      <Group gap={4}>
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
                className={classes.scrollViewport}
              >
                <Stack gap="md" pt={image.needsReview ? 0 : 'md'} pb="md" style={{ flex: 1 }}>
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
                      <Stack gap={8}>
                        <MetricSubscriptionProvider entityType="Image" entityId={image.id}>
                          <ImageDetailByPropsReactions
                            imageId={image.id}
                            reactions={reactions}
                            stats={stats}
                            userId={user?.id}
                          />
                        </MetricSubscriptionProvider>
                        {user?.id && <ImageDetailComments imageId={image.id} userId={user.id} />}
                      </Stack>
                    </Paper>
                  </div>
                  <Stack gap="md" mt="auto">
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
    </>
  );
}

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
    <div ref={setRef} className={clsx(classes.root, className)}>
      {canNavigate && (
        <>
          {!!prevImageId && (
            <UnstyledButton
              className={clsx(classes.control, classes.prev)}
              onClick={() => onSetImage(prevImageId)}
            >
              <IconChevronLeft />
            </UnstyledButton>
          )}
          {!!nextImageId && (
            <UnstyledButton
              className={clsx(classes.control, classes.next)}
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
                style={{
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

function ImageDetailByPropsReactions({
  imageId,
  reactions,
  stats,
  userId,
}: {
  imageId: number;
  reactions: { userId: number; reaction: any }[];
  stats: {
    likeCountAllTime: number;
    dislikeCountAllTime: number;
    heartCountAllTime: number;
    laughCountAllTime: number;
    cryCountAllTime: number;
  } | null;
  userId?: number;
}) {
  const reactionMetrics = useLiveMetrics('Image', imageId, {
    likeCount: stats?.likeCountAllTime ?? 0,
    dislikeCount: stats?.dislikeCountAllTime ?? 0,
    heartCount: stats?.heartCountAllTime ?? 0,
    laughCount: stats?.laughCountAllTime ?? 0,
    cryCount: stats?.cryCountAllTime ?? 0,
  });

  return (
    <Reactions
      entityId={imageId}
      entityType="image"
      reactions={reactions}
      metrics={reactionMetrics}
      targetUserId={userId}
    />
  );
}
