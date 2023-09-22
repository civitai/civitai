import {
  ActionIcon,
  Box,
  Button,
  Card,
  CloseButton,
  createStyles,
  Divider,
  Group,
  MantineProvider,
  Paper,
  ScrollArea,
  Stack,
  Text,
} from '@mantine/core';
import {
  IconInfoCircle,
  IconDotsVertical,
  IconAlertTriangle,
  IconEye,
  IconPlaylistAdd,
} from '@tabler/icons-react';
import { IconShare3 } from '@tabler/icons-react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { ImageMeta } from '~/components/ImageMeta/ImageMeta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Reactions } from '~/components/Reaction/Reactions';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { ImageDetailContextMenu } from '~/components/Image/Detail/ImageDetailContextMenu';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { ImageDetailComments } from '~/components/Image/Detail/ImageDetailComments';
import { ImageDetailCarousel } from '~/components/Image/Detail/ImageDetailCarousel';
import { ImageResources } from '~/components/Image/Detail/ImageResources';
import { Meta } from '~/components/Meta/Meta';
import { TrackView } from '~/components/TrackView/TrackView';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { CollectionType } from '@prisma/client';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { openContext } from '~/providers/CustomModalsProvider';
import { TipBuzzButton } from '~/components/Buzz/TipBuzzButton';

export function ImageDetail() {
  const { classes, cx, theme } = useStyles();
  const { image, isLoading, active, toggleInfo, close, isMod, shareUrl } = useImageDetailContext();

  if (isLoading) return <PageLoader />;
  if (!image) return <NotFound />;

  return (
    <>
      <Meta
        title={`Image posted by ${image.user.username}`}
        image={image.url == null ? undefined : getEdgeUrl(image.url, { width: 1200 })}
      />
      <TrackView entityId={image.id} entityType="Image" type="ImageView" />
      <MantineProvider theme={{ colorScheme: 'dark' }} inherit>
        <Paper className={classes.root}>
          <CloseButton
            style={{ position: 'absolute', top: 15, right: 15, zIndex: 10 }}
            size="lg"
            variant="default"
            onClick={close}
            className={classes.mobileOnly}
          />
          <ImageDetailCarousel className={classes.carousel} />
          <ActionIcon
            size="lg"
            className={cx(classes.info, classes.mobileOnly)}
            onClick={toggleInfo}
            variant="default"
          >
            <IconInfoCircle />
          </ActionIcon>
          <Card
            className={cx(classes.sidebar, {
              [classes.active]: active,
            })}
          >
            <Card.Section py="xs" withBorder inheritPadding>
              <Group position="apart" spacing={8}>
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
                <Group spacing={8} sx={{ [theme.fn.smallerThan('sm')]: { flexGrow: 1 } }} noWrap>
                  <TipBuzzButton
                    toUserId={image.user.id}
                    entityId={image.id}
                    entityType="Image"
                    size="md"
                    compact
                  />
                  <FollowUserButton userId={image.user.id} size="md" compact />
                  <CloseButton
                    size="md"
                    radius="xl"
                    variant="transparent"
                    ml="auto"
                    iconSize={20}
                    onClick={(e) => {
                      e.stopPropagation();
                      close();
                    }}
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
                  <ShareButton
                    url={shareUrl}
                    title={`Image by ${image.user.username}`}
                    collect={{ type: CollectionType.Image, imageId: image.id }}
                  >
                    <Button
                      size="md"
                      radius="xl"
                      color="gray"
                      variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                      compact
                    >
                      <Group spacing={4}>
                        <IconShare3 size={14} />
                        <Text size="xs">Share</Text>
                      </Group>
                    </Button>
                  </ShareButton>
                </Group>
                <ImageDetailContextMenu>
                  <ActionIcon
                    size={30}
                    variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                    radius="xl"
                  >
                    <IconDotsVertical size={14} />
                  </ActionIcon>
                </ImageDetailContextMenu>
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
                  canAddModerated={isMod}
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
                          tippedAmountCount: image.stats?.tippedAmountCountAllTime,
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
                  {image.meta && (
                    <>
                      <Divider label="Generation Data" labelPosition="center" mb={-15} />
                      <Box px="md">
                        <ImageMeta meta={image.meta} imageId={image.id} />
                      </Box>
                    </>
                  )}
                </Stack>
              </Stack>
            </Card.Section>
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
