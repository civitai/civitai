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
  IconFlag,
  IconInfoCircle,
  IconShare,
  IconDotsVertical,
  IconAlertTriangle,
} from '@tabler/icons';
import { NotFound } from '~/components/AppLayout/NotFound';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { ImageMeta } from '~/components/ImageMeta/ImageMeta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Reactions } from '~/components/Reaction/Reactions';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { ImageDetailContextMenu } from '~/components/Image/Detail/ImageDetailContextMenu';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { VotableTags } from '~/components/VotableTags/VotableTags';
import { useImageDetailContext } from '~/components/Image/Detail/ImageDetailProvider';
import { ImageDetailComments } from '~/components/Image/Detail/ImageDetailComments';
import { ReportImageButton } from '~/components/Gallery/ReportImageButton';
import { ImageDetailCarousel } from '~/components/Image/Detail/ImageDetailCarousel';
import { ImageResources } from '~/components/Image/Detail/ImageResources';
import { Meta } from '~/components/Meta/Meta';
import { TrackView } from '~/components/TrackView/TrackView';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { RoutedContextLink } from '~/providers/RoutedContextProvider';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';

export function ImageDetail() {
  const { classes, cx } = useStyles();
  const { image, isLoading, active, toggleInfo, close, isOwner, isMod, shareUrl } =
    useImageDetailContext();

  if (!image && isLoading) return <PageLoader />;
  if (!image) return <NotFound />;

  return (
    <>
      <Meta
        title={`Image posted by ${image.user.username}`}
        image={image.url == null ? undefined : getEdgeUrl(image.url, { width: 1200 })}
      />
      <TrackView entityId={image.id} entityType="Image" type="ImageView" />
      <MantineProvider theme={{ colorScheme: 'dark' }}>
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
            <Card.Section withBorder>
              <Stack p="sm" spacing={8}>
                <Group noWrap>
                  <Group position="apart" style={{ flex: 1 }}>
                    <UserAvatar
                      user={image.user}
                      subText={<DaysFromNow date={image.createdAt} />}
                      subTextForce
                      withUsername
                      linkToProfile
                    />
                    <Group spacing={4}>
                      <ShareButton url={shareUrl} title={`Image by ${image.user.username}`}>
                        <ActionIcon size="lg">
                          <IconShare />
                        </ActionIcon>
                      </ShareButton>
                      <ReportImageButton imageId={image.id}>
                        <ActionIcon size="lg">
                          <IconFlag />
                        </ActionIcon>
                      </ReportImageButton>
                      {(isMod || isOwner) && (
                        <ImageDetailContextMenu>
                          <ActionIcon size="lg">
                            <IconDotsVertical />
                          </ActionIcon>
                        </ImageDetailContextMenu>
                      )}
                    </Group>
                  </Group>
                  <CloseButton size="lg" variant="default" onClick={close} />
                </Group>
              </Stack>
            </Card.Section>
            {image.postId && (
              <Card.Section withBorder>
                <Stack p="sm" spacing={8}>
                  {image.postTitle ? (
                    <Group spacing="xs" noWrap>
                      <Text size="sm" weight={500} sx={{ whiteSpace: 'nowrap' }}>
                        Post
                      </Text>
                      <RoutedContextLink
                        modal="postDetailModal"
                        postId={image.postId}
                        key="view-post"
                      >
                        <Text size="sm" variant="link" td="underline" lineClamp={1}>
                          {image.postTitle ?? 'Untitled'}
                        </Text>
                      </RoutedContextLink>
                    </Group>
                  ) : (
                    <RoutedContextLink
                      modal="postDetailModal"
                      postId={image.postId}
                      key="view-post"
                    >
                      <Button size="xs" variant="outline" fullWidth>
                        View Post
                      </Button>
                    </RoutedContextLink>
                  )}
                </Stack>
              </Card.Section>
            )}
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
                        <ImageMeta meta={image.meta as ImageMetaProps} />
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
      width: 400,
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
