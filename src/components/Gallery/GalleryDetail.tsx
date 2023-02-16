import {
  ActionIcon,
  Badge,
  Box,
  Card,
  CloseButton,
  createStyles,
  Divider,
  Group,
  LoadingOverlay,
  MantineProvider,
  Menu,
  Paper,
  ScrollArea,
  Stack,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { closeModal, openConfirmModal } from '@mantine/modals';
import {
  IconFlag,
  IconInfoCircle,
  IconShare,
  IconDotsVertical,
  IconTrash,
  IconBan,
  IconLock,
} from '@tabler/icons';
import Router, { useRouter } from 'next/router';
import { useEffect, useMemo, useRef } from 'react';

import { NotFound } from '~/components/AppLayout/NotFound';
import { ToggleLockComments } from '~/components/CommentsV2';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { GalleryCarousel } from '~/components/Gallery/GalleryCarousel';
import { useGalleryFilters } from '~/components/Gallery/GalleryFilters';
import { GalleryImageComments } from '~/components/Gallery/GalleryImageComments';
import { ReportImageButton } from '~/components/Gallery/ReportImageButton';
import { ImageMeta } from '~/components/ImageMeta/ImageMeta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { Reactions } from '~/components/Reaction/Reactions';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { useHasClientHistory } from '~/store/ClientHistoryStore';
import { showErrorNotification } from '~/utils/notifications';
import { QS } from '~/utils/qs';
import { trpc } from '~/utils/trpc';

export function GalleryDetail() {
  const router = useRouter();
  const id = Number(router.query.galleryImageId);
  const { filters } = useGalleryFilters();
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();
  const closingRef = useRef(false);
  // const { back: goBack } = useNavigateBack();
  const returnUrl = router.query.returnUrl as string;
  const active = router.query.active === 'true';
  const hasHistory = useHasClientHistory();
  const queryUtils = trpc.useContext();

  const { modelId, modelVersionId, reviewId, userId, infinite } = filters;

  // #region [data fetching]
  const { data: infiniteGallery, isLoading: infiniteLoading } =
    trpc.image.getGalleryImagesInfinite.useInfiniteQuery(filters, { enabled: infinite });

  const { data: finiteGallery, isLoading: finiteLoading } = trpc.image.getGalleryImages.useQuery(
    filters,
    {
      enabled: !infinite,
    }
  );
  const isLoading = infinite ? infiniteLoading : finiteLoading;

  const galleryImages = useMemo(
    () => infiniteGallery?.pages.flatMap((x) => x.items) ?? finiteGallery ?? [],
    [infiniteGallery, finiteGallery]
  );

  // only allow this to run if the detail data isn't included in the list result
  const { data: prefetchImage } = trpc.image.getGalleryImageDetail.useQuery(
    { id },
    { enabled: !galleryImages.some((x) => x.id === id) }
  );

  const image = galleryImages.find((x) => x.id === id) ?? prefetchImage;
  // #endregion

  const shareUrl = useMemo(() => {
    const [pathname, queryString] = router.asPath.split('?');
    const { active, ...query } = QS.parse(queryString);
    return Object.keys(query).length > 0 ? `${pathname}?${QS.stringify(query)}` : pathname;
  }, [router]);

  // #region [back button functionality]
  const handleCloseContext = () => {
    if (closingRef.current) return;
    const [, queryString] = router.asPath.split('?');
    const { active, ...query } = QS.parse(queryString) as any;
    if (active) {
      if (hasHistory) router.back();
      else router.replace({ query: router.query }, { query }, { shallow: true });
    } else {
      if (hasHistory) router.back();
      else router.push(returnUrl ?? '/gallery', undefined, { shallow: true });
    }
  };
  useHotkeys([['Escape', handleCloseContext]]);

  const handleClosingStart = () => {
    closingRef.current = true;
  };
  const handleClosingEnd = () => {
    closingRef.current = false;
  };

  useEffect(() => {
    Router.events.on('routeChangeStart', handleClosingStart);
    Router.events.on('routeChangeComplete', handleClosingEnd);

    return () => {
      Router.events.off('routeChangeStart', handleClosingStart);
      Router.events.off('routeChangeComplete', handleClosingEnd);
    };
  }, []);
  // #endregion

  const handleToggleInfo = () => {
    const [, queryString] = router.asPath.split('?');
    const { active, ...query } = QS.parse(queryString) as any;

    router.push(
      { query: { ...router.query, active: !active } },
      { query: { ...query, active: !active } },
      // { pathname: router.asPath, query: { ...router.query, active: !active } },
      { shallow: true }
    );
  };

  const deleteMutation = trpc.image.delete.useMutation({
    async onSuccess() {
      if (image && image.connections?.modelId) {
        await queryUtils.model.getById.invalidate({ id: image.connections?.modelId });

        if (image.connections?.reviewId) {
          await queryUtils.review.getDetail.invalidate({ id: image.connections?.reviewId });
          await queryUtils.review.getAll.invalidate({ modelId: image.connections?.modelId });
        }
      }
      handleCloseContext();
    },
    onError(error) {
      showErrorNotification({ error: new Error(error.message) });
    },
  });
  const handleDeleteImage = () => {
    if (image) deleteMutation.mutate({ id: image.id });
  };

  const tosViolationMutation = trpc.image.setTosViolation.useMutation({
    async onSuccess() {
      if (image) {
        await queryUtils.image.getGalleryImageDetail.invalidate({ id: image.id });
        if (image.connections?.modelId)
          await queryUtils.model.getById.invalidate({ id: image.connections?.modelId });
      }
      closeModal('confirm-tos-violation');
      handleCloseContext();
    },
    onError(error) {
      showErrorNotification({
        error: new Error(error.message),
        title: 'Could not report review, please try again',
      });
    },
  });
  const handleTosViolation = () => {
    openConfirmModal({
      modalId: 'confirm-tos-violation',
      title: 'Report ToS Violation',
      children: `Are you sure you want to report this image for a Terms of Service violation? Once marked, it won't show up for other people`,
      centered: true,
      labels: { confirm: 'Yes', cancel: 'Cancel' },
      confirmProps: { color: 'red', loading: tosViolationMutation.isLoading },
      closeOnConfirm: false,
      onConfirm: image ? () => tosViolationMutation.mutate({ id: image.id }) : undefined,
    });
  };

  if (!image && isLoading) return <PageLoader />;
  if (!image) return <NotFound />;
  // if (image?.nsfw && !currentUser?.showNsfw) return <SensitiveShield />;

  const isMod = currentUser?.isModerator ?? false;
  const isOwner = currentUser?.id === image.user.id;

  return (
    <MantineProvider theme={{ colorScheme: 'dark' }}>
      <Paper className={classes.root}>
        <CloseButton
          style={{ position: 'absolute', top: 15, right: 15, zIndex: 10 }}
          size="lg"
          variant="default"
          onClick={handleCloseContext}
          className={classes.mobileOnly}
        />
        <GalleryCarousel
          className={classes.carousel}
          current={image}
          images={galleryImages}
          connect={
            userId
              ? { entityType: 'user', entityId: userId }
              : reviewId
              ? { entityType: 'review', entityId: reviewId }
              : // : modelVersionId
              // ? { entityType: 'modelVersion', entityId: modelVersionId }
              modelId
              ? { entityType: 'model', entityId: modelId }
              : undefined
          }
          withIndicators={!infinite}
        />
        <ActionIcon
          size="lg"
          className={cx(classes.info, classes.mobileOnly)}
          onClick={handleToggleInfo}
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
                    <Menu position="left">
                      <Menu.Target>
                        <ActionIcon size="lg">
                          <IconDotsVertical />
                        </ActionIcon>
                      </Menu.Target>
                      <Menu.Dropdown>
                        <Menu.Item
                          color="red"
                          icon={<IconTrash size={14} stroke={1.5} />}
                          onClick={handleDeleteImage}
                          disabled={deleteMutation.isLoading}
                        >
                          Delete
                        </Menu.Item>
                        {isMod && (
                          <>
                            <Menu.Item
                              icon={<IconBan size={14} stroke={1.5} />}
                              onClick={handleTosViolation}
                            >
                              Remove as TOS Violation
                            </Menu.Item>
                            <ToggleLockComments entityId={image.id} entityType="image">
                              {({ toggle, locked }) => {
                                return (
                                  <Menu.Item
                                    icon={<IconLock size={14} stroke={1.5} />}
                                    onClick={toggle}
                                  >
                                    {locked ? 'Unlock' : 'Lock'} Comments
                                  </Menu.Item>
                                );
                              }}
                            </ToggleLockComments>
                          </>
                        )}
                      </Menu.Dropdown>
                    </Menu>
                  )}
                </Group>
              </Group>
              <CloseButton size="lg" variant="default" onClick={handleCloseContext} />
            </Group>
          </Card.Section>
          <Card.Section component={ScrollArea} style={{ flex: 1, position: 'relative' }}>
            <LoadingOverlay visible={deleteMutation.isLoading} />
            <Stack spacing="md" py="md">
              <Box px="sm">
                <Reactions
                  entityId={image.id}
                  entityType="image"
                  reactions={image.reactions}
                  metrics={image.metrics}
                />
              </Box>
              <Group spacing={4} px="md">
                {image.tags.map((tag) => (
                  <Badge key={tag.id}>{tag.name}</Badge>
                ))}
              </Group>
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
                    <ImageMeta
                      meta={image.meta as ImageMetaProps}
                      generationProcess={image.generationProcess ?? 'txt2img'}
                    />
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
