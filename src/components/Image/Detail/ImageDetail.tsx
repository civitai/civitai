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
import { Availability, CollectionType, NsfwLevel } from '@prisma/client';
import {
  IconAlertTriangle,
  IconBookmark,
  IconDotsVertical,
  IconEye,
  IconFlag,
  IconX,
} from '@tabler/icons-react';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { adsRegistry } from '~/components/Ads/adsRegistry';
import { Adunit } from '~/components/Ads/AdUnit';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { TipBuzzButton } from '~/components/Buzz/TipBuzzButton';
import { ChatUserButton } from '~/components/Chat/ChatUserButton';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { FollowUserButton } from '~/components/FollowUserButton/FollowUserButton';
import { ImageDetailCarousel } from '~/components/Image/Detail/ImageDetailCarousel';
import { ImageDetailComments } from '~/components/Image/Detail/ImageDetailComments';
import { ImageDetailContextMenu } from '~/components/Image/Detail/ImageDetailContextMenu';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { ImageResources } from '~/components/Image/Detail/ImageResources';
import { ImageMeta } from '~/components/ImageMeta/ImageMeta';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Reactions } from '~/components/Reaction/Reactions';
import { ReactionSettingsProvider } from '~/components/Reaction/ReactionSettingsProvider';
import { TrackView } from '~/components/TrackView/TrackView';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { env } from '~/env/client.mjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { BrowsingMode } from '~/server/common/enums';
import { ReportEntity } from '~/server/schema/report.schema';
import { containerQuery } from '~/utils/mantine-css-helpers';

const UNFURLABLE: NsfwLevel[] = [NsfwLevel.None, NsfwLevel.Soft];
export function ImageDetail() {
  const { classes, cx, theme } = useStyles();
  const { image, isLoading, active, close, toggleInfo, shareUrl } = useImageDetailContext();
  const { query } = useBrowserRouter();
  const currentUser = useCurrentUser();

  if (isLoading) return <PageLoader />;
  if (!image) return <NotFound />;

  const nsfw = image.nsfw !== 'None';

  return (
    <>
      <Meta
        title={`Image posted by ${image.user.username}`}
        image={
          image.url == null || !UNFURLABLE.includes(image.nsfw)
            ? undefined
            : getEdgeUrl(image.url, { width: 1200 })
        }
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/images/${image.id}`, rel: 'canonical' }]}
        deIndex={
          image.nsfw !== NsfwLevel.None ||
          !!image.needsReview ||
          image.availability === Availability.Unsearchable
            ? 'noindex, nofollow'
            : undefined
        }
      />
      <TrackView entityId={image.id} entityType="Image" type="ImageView" nsfw={nsfw} />
      <MantineProvider theme={{ colorScheme: 'dark' }} inherit>
        <Paper
          className={cx(classes.root, {
            [classes.active]: active,
          })}
        >
          <div className={classes.carouselWrapper}>
            <ReactionSettingsProvider
              settings={{
                hideReactionCount: false,
                buttonStyling: (reaction, hasReacted) => ({
                  radius: 'xl',
                  variant: 'light',
                  px: undefined,
                  pl: 4,
                  pr: 8,
                  h: 30,
                  style: {
                    color: 'white',
                    background: hasReacted
                      ? theme.fn.rgba(theme.colors.blue[4], 0.4)
                      : theme.fn.rgba(theme.colors.gray[8], 0.4),
                    backdropFilter: 'blur(7px)',
                  },
                }),
              }}
            >
              <ImageDetailCarousel className={classes.carousel} />
            </ReactionSettingsProvider>
          </div>
          <Card className={cx(classes.sidebar)}>
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
                <Group spacing={8} noWrap>
                  <TipBuzzButton
                    toUserId={image.user.id}
                    entityId={image.id}
                    entityType="Image"
                    size="md"
                    compact
                  />
                  <ChatUserButton user={image.user} size="md" compact />
                  <FollowUserButton userId={image.user.id} size="md" compact />
                  <ActionIcon
                    onClick={toggleInfo}
                    size="md"
                    radius="xl"
                    className={classes.mobileOnly}
                  >
                    <IconX size={20} />
                  </ActionIcon>
                  <CloseButton
                    size="md"
                    radius="xl"
                    variant="transparent"
                    ml="auto"
                    iconSize={20}
                    className={classes.desktopOnly}
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
              <Stack spacing={8}>
                <Group position="apart" spacing={8}>
                  <Group spacing={8}>
                    {image.postId &&
                      (!query.postId ? (
                        <RoutedDialogLink
                          name="postDetail"
                          state={{ postId: image.postId }}
                          passHref
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
                      ) : (
                        <Button
                          component="a"
                          size="md"
                          radius="xl"
                          color="gray"
                          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                          compact
                          onClick={close}
                        >
                          <Group spacing={4}>
                            <IconEye size={14} />
                            <Text size="xs">View post</Text>
                          </Group>
                        </Button>
                      ))}
                    <ActionIcon
                      size={30}
                      radius="xl"
                      color="gray"
                      variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                      onClick={() =>
                        openContext('addToCollection', {
                          imageId: image.id,
                          type: CollectionType.Image,
                        })
                      }
                    >
                      <IconBookmark size={14} />
                    </ActionIcon>
                  </Group>
                  <Group spacing={8}>
                    <LoginRedirect reason={'report-content'}>
                      <ActionIcon
                        size={30}
                        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
                        radius="xl"
                        onClick={(e) => {
                          openContext('report', {
                            entityType: ReportEntity.Image,
                            entityId: image.id,
                          });
                        }}
                      >
                        <IconFlag size={14} stroke={2} />
                      </ActionIcon>
                    </LoginRedirect>
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
                </Group>
              </Stack>
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
                <VotableTags entityType="image" entityId={image.id} canAdd collapsible px="sm" />
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
                        targetUserId={image.user.id}
                      />
                      <ImageDetailComments imageId={image.id} userId={image.user.id} />
                    </Stack>
                  </Paper>
                </div>
                <Adunit
                  browsingModeOverride={!nsfw ? BrowsingMode.SFW : undefined}
                  showRemoveAds
                  {...adsRegistry.imageDetail}
                />
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
  const isMobile = containerQuery.smallerThan('sm');
  const isDesktop = containerQuery.largerThan('sm');
  const sidebarWidth = 457;
  return {
    root: {
      flex: 1,
      display: 'flex',
      position: 'relative',
      overflow: 'hidden',
      zIndex: 200,
      transition: '.3s ease padding-right',

      [`&.${getRef('active')}`]: {
        paddingRight: sidebarWidth,

        [isMobile]: {
          paddingRight: 0,
        },
      },
    },
    carouselWrapper: {
      flex: 1,
      alignItems: 'stretch',
      position: 'relative',
    },
    carousel: {
      width: '100%',
      height: '100%',
    },
    active: { ref: getRef('active') },
    sidebar: {
      width: sidebarWidth,
      borderRadius: 0,
      borderLeft: `1px solid ${theme.colors.dark[4]}`,
      display: 'flex',
      flexDirection: 'column',
      position: 'absolute',
      transition: '.3s ease transform',
      right: 0,
      transform: 'translateX(100%)',
      height: '100%',

      [`.${getRef('active')} &`]: {
        transform: 'translateX(0)',
      },

      [isMobile]: {
        position: 'absolute',
        top: '100%',
        left: 0,
        width: '100%',
        height: '100%',
        transform: 'translateY(100%)',
        zIndex: 20,

        [`.${getRef('active')} &`]: {
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
