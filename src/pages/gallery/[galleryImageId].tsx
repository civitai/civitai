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
  Paper,
  MantineProvider,
  Card,
  Group,
  CloseButton,
  ActionIcon,
} from '@mantine/core';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';

import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { IconFlag, IconInfoCircle, IconShare, IconDotsVertical } from '@tabler/icons';
import { ShareButton } from '~/components/ShareButton/ShareButton';
import { QS } from '~/utils/qs';

// TODO - mobile first approach
/*
  reconsider navbar design (consider artstation)
*/

export default function GalleryImageDetail() {
  const router = useRouter();
  const id = Number(router.query.galleryImageId);
  const filters = useGalleryFilters();
  const currentUser = useCurrentUser();
  const { classes, cx } = useStyles();

  const { data: gallery } = trpc.image.getGalleryImagesInfinite.useInfiniteQuery({ ...filters });

  const galleryImages = useMemo(() => gallery?.pages.flatMap((x) => x.items) ?? [], [gallery]);

  const { data: image = galleryImages.find((x) => x.id === id) } =
    trpc.image.getGalleryImageDetail.useQuery(
      {
        id,
      },
      {
        // only allow this to run if the detail data isn't included in the list result
        enabled: !galleryImages.some((x) => x.id === id),
      }
    );

  const shareUrl = useMemo(() => {
    const [pathname, queryString] = router.asPath.split('?');
    const { active, ...query } = QS.parse(queryString);
    return Object.keys(query).length > 0 ? `${pathname}?${QS.stringify(query)}` : pathname;
  }, [router]);

  // if (imageLoading) return <PageLoader />;
  if (!image) return <NotFound />;
  if (image?.nsfw && !currentUser?.showNsfw) return <SensitiveShield />;
  const { modelId, modelVersionId, reviewId, userId } = filters;

  const handleToggleInfo = () => {
    const active = router.query.active === 'true';
    router.replace({ query: { ...router.query, active: !active } }, undefined, { shallow: true });
  };

  const handleCloseContext = () => {
    const { active, ...query } = router.query;
    active === 'true' ? router.replace({ query }, undefined, { shallow: true }) : router.back();
  };

  return (
    <div className={classes.root}>
      {/* TODO - Visible on mobile when not active */}
      <CloseButton
        style={{ position: 'absolute', top: 15, right: 15, zIndex: 10 }}
        size="lg"
        variant="default"
        onClick={router.back}
        className={classes.mobileOnly}
      />
      <GalleryCarousel
        className={classes.carousel}
        current={image}
        images={galleryImages}
        connect={
          modelId
            ? { entityType: 'model', entityId: modelId }
            : modelVersionId
            ? { entityType: 'modelVersion', entityId: modelVersionId }
            : reviewId
            ? { entityType: 'review', entityId: reviewId }
            : userId
            ? { entityType: 'user', entityId: userId }
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
          [classes.active]: filters.active,
        })}
      >
        <Card.Section withBorder>
          <Group p="sm" position="apart">
            <UserAvatar
              user={image.user}
              subText={<DaysFromNow date={image.createdAt} />}
              subTextForce
              withUsername
              linkToProfile
            />
            <Group>
              <Group spacing={4}>
                {/* TODO - determine if we need to add a title/description */}
                <ShareButton url={shareUrl}>
                  <ActionIcon size="lg">
                    <IconShare />
                  </ActionIcon>
                </ShareButton>
                <ActionIcon size="lg">
                  <IconFlag />
                </ActionIcon>
                {/* TODO - consider moving edit/delete somewhere else */}
                <ActionIcon size="lg">
                  <IconDotsVertical />
                </ActionIcon>
              </Group>
              <CloseButton size="lg" variant="default" onClick={handleCloseContext} />
            </Group>
          </Group>
        </Card.Section>
        <Card.Section>
          {/* TODO - REACTIONS */}
          {/* TODO - COMMENTS */}
          {/* TODO - TAGS */}
          {/* TODO - RESOURCES */}
          {/* TODO - META */}
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
    mobileOnly: {
      [isDesktop]: {
        display: 'none',
      },
    },
    desktopOnly: {
      [isMobile]: {
        display: 'none',
      },
    },
    info: {
      position: 'absolute',
      bottom: theme.spacing.md,
      right: theme.spacing.md,
    },
  };
});
