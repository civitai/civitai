import { GetServerSideProps } from 'next/types';
import { useRouter } from 'next/router';
import { useGalleryFilters } from '~/components/Gallery/GalleryFilters';
import { trpc } from '~/utils/trpc';
import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';
import { isNumber } from '~/utils/type-guards';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SensitiveShield } from '~/components/SensitiveShield/SensitiveShield';
import { useMemo } from 'react';
import { GalleryCarousel } from '~/components/Gallery/GalleryCarousel';
import {
  createStyles,
  MantineProvider,
  Card,
  Group,
  CloseButton,
  ActionIcon,
  ScrollArea,
  Stack,
  Paper,
  Box,
} from '@mantine/core';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';

import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { IconFlag, IconInfoCircle, IconShare, IconDotsVertical } from '@tabler/icons';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { QS } from '~/utils/qs';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { ImageMeta } from '~/components/ImageMeta/ImageMeta';
import { useNavigateBack } from '~/providers/NavigateBackProvider';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { useHotkeys } from '@mantine/hooks';
import { ReportImageButton } from '~/components/Gallery/ReportImageButton';
import { Reactions } from '~/components/Reaction/Reactions';

export default function GalleryImageDetail() {
  const router = useRouter();
  const id = Number(router.query.galleryImageId);
  const filters = useGalleryFilters();
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();
  const { back: goBack } = useNavigateBack();
  const returnUrl = router.query.returnUrl as string;
  const active = router.query.active === 'true';

  const { modelId, modelVersionId, reviewId, userId, infinite = true } = filters;

  // #region [data fetching]
  const { data: infiniteGallery, isLoading: infiniteLoading } =
    trpc.image.getGalleryImagesInfinite.useInfiniteQuery(filters, { enabled: infinite });

  const { data: finiteGallery, isLoading: finiteLoading } = trpc.image.getGalleryImages.useQuery(
    filters,
    {
      enabled: !infinite,
    }
  );
  const isLoading = infiniteLoading || finiteLoading;

  // const {data: }
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

  // #region [back button functionality]
  const handleBackClick = () => goBack(returnUrl ?? '/gallery');

  const handleCloseContext = () => {
    const { active, ...query } = router.query;
    if (active === 'true') {
      goBack({ query }, undefined, { shallow: true });
    } else {
      handleBackClick();
    }
  };
  useHotkeys([['Escape', handleBackClick]]);
  // #endregion

  const shareUrl = useMemo(() => {
    const [pathname, queryString] = router.asPath.split('?');
    const { active, ...query } = QS.parse(queryString);
    return Object.keys(query).length > 0 ? `${pathname}?${QS.stringify(query)}` : pathname;
  }, [router]);

  const handleToggleInfo = () => {
    const active = router.query.active === 'true';
    router.push({ query: { ...router.query, active: !active } }, undefined, { shallow: true });
  };

  if (!image && isLoading) return <PageLoader />;
  if (!image) return <NotFound />;
  if (image?.nsfw && !currentUser?.showNsfw) return <SensitiveShield />;

  return (
    // TODO.gallery - <Meta />
    <div className={classes.root}>
      <CloseButton
        style={{ position: 'absolute', top: 15, right: 15, zIndex: 10 }}
        size="lg"
        variant="default"
        onClick={handleBackClick}
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
                {/* TODO.gallery - reporting */}
                <ReportImageButton imageId={image.id}>
                  <ActionIcon size="lg">
                    <IconFlag />
                  </ActionIcon>
                </ReportImageButton>
                {/* <ActionIcon size="lg">
                  <IconDotsVertical />
                </ActionIcon> */}
              </Group>
            </Group>
            <CloseButton size="lg" variant="default" onClick={handleCloseContext} />
          </Group>
        </Card.Section>
        <Card.Section component={ScrollArea} style={{ flex: 1 }}>
          <Stack spacing="md" pt="md">
            <Box px="md">
              <Reactions
                entityId={image.id}
                entityType="image"
                reactions={image.reactions}
                metrics={image.metrics}
              />
            </Box>
            {/* TODO.gallery - REACTIONS */}
            {/* TODO.gallery - COMMENTS */}
            {/* TODO.gallery - TAGS */}
            {/* TODO.gallery - RESOURCES */}
            {/* TODO.gallery - META */}
            {image.meta && (
              <Paper p="md">
                <ImageMeta meta={image.meta as ImageMetaProps} />
              </Paper>
            )}
          </Stack>
        </Card.Section>
      </Card>
    </div>
  );
}

GalleryImageDetail.getLayout = (page: any) => (
  <MantineProvider theme={{ colorScheme: 'dark' }}>{page}</MantineProvider>
);

export const getServerSideProps: GetServerSideProps = async (context) => {
  const isClient = context.req.url?.startsWith('/_next/data');
  const params = (context.params ?? {}) as { galleryImageId: string };
  const id = Number(params.galleryImageId);
  if (!isNumber(id)) return { notFound: true };

  const ssg = await getServerProxySSGHelpers(context);
  if (!isClient) {
    await ssg.image.getGalleryImageDetail.prefetch({ id });
  }

  return {
    props: {
      trpcState: ssg.dehydrate(),
    },
  };
};

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
