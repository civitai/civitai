import {
  ActionIcon,
  Box,
  Card,
  CloseButton,
  createStyles,
  Divider,
  Group,
  MantineProvider,
  Paper,
  ScrollArea,
  Stack,
} from '@mantine/core';
import { IconFlag, IconInfoCircle, IconShare, IconDotsVertical } from '@tabler/icons';
import { NotFound } from '~/components/AppLayout/NotFound';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { GalleryCarousel2 } from './GalleryCarousel2';
import { useGalleryDetailContext } from './GalleryDetailProvider';
import { GalleryImageComments } from './GalleryImageComments';
import { ReportImageButton } from './ReportImageButton';
import { ImageMeta } from '~/components/ImageMeta/ImageMeta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Reactions } from '~/components/Reaction/Reactions';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { GalleryDetailContextMenu } from '~/components/Gallery/GalleryDetailContextMenu';

export function GalleryDetail2() {
  const { classes, cx } = useStyles();
  const {
    image,
    isLoading,
    active,
    toggleInfo,
    close,
    infinite,
    modelId,
    reviewId,
    userId,
    isOwner,
    isMod,
    shareUrl,
  } = useGalleryDetailContext();

  if (!image && isLoading) return <PageLoader />;
  if (!image) return <NotFound />;

  return (
    <MantineProvider theme={{ colorScheme: 'dark' }}>
      <Paper className={classes.root}>
        <CloseButton
          style={{ position: 'absolute', top: 15, right: 15, zIndex: 10 }}
          size="lg"
          variant="default"
          onClick={close}
          className={classes.mobileOnly}
        />
        <GalleryCarousel2
          className={classes.carousel}
          withIndicators={!infinite}
          connect={
            userId
              ? { entityType: 'user', entityId: userId }
              : reviewId
              ? { entityType: 'review', entityId: reviewId }
              : modelId
              ? { entityType: 'model', entityId: modelId }
              : undefined
          }
        />
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
            <Group p="sm" noWrap>
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
                    <GalleryDetailContextMenu>
                      <ActionIcon size="lg">
                        <IconDotsVertical />
                      </ActionIcon>
                    </GalleryDetailContextMenu>
                  )}
                </Group>
              </Group>
              <CloseButton size="lg" variant="default" onClick={close} />
            </Group>
          </Card.Section>
          <Card.Section component={ScrollArea} style={{ flex: 1, position: 'relative' }}>
            {/* TODO.gallery - do I need this? */}
            {/* <LoadingOverlay visible={deleteMutation.isLoading} /> */}
            <Stack spacing="md" py="md">
              <Box px="sm">
                <Reactions
                  entityId={image.id}
                  entityType="image"
                  reactions={image.reactions}
                  metrics={image.metrics}
                />
              </Box>
              <div>
                <Divider
                  label="Comments"
                  labelPosition="center"
                  styles={{
                    label: {
                      marginTop: '-9px !important',
                      marginBottom: -9,
                    },
                  }}
                />
                <Paper p="sm" pt="lg" radius={0}>
                  <GalleryImageComments imageId={image.id} userId={image.user.id} />
                </Paper>
              </div>
              {/* TODO.gallery - TAGS */}
              {/* TODO.gallery - RESOURCES */}
              {/* TODO.gallery - META */}
              {image.meta && (
                <>
                  <Divider label="Generation Data" labelPosition="center" mb={-15} />
                  <Box px="md">
                    <ImageMeta meta={image.meta as ImageMetaProps} />
                  </Box>
                </>
              )}
            </Stack>
          </Card.Section>
        </Card>
      </Paper>
    </MantineProvider>
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
  };
});
