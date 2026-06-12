import { keepPreviousData } from '@tanstack/react-query';
import {
  Anchor,
  Button,
  Center,
  Group,
  Loader,
  LoadingOverlay,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconCloudOff,
  IconEye,
  IconEyeOff,
  IconPlus,
  IconSettings,
  IconStar,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ButtonTooltip } from '~/components/CivitaiWrapped/ButtonTooltip';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { SortFilter } from '~/components/Filters';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import {
  useGallerySettings,
  useModel3DGallerySettings,
} from '~/components/Image/AsPosts/gallery.utils';
import { ImagesAsPostsCard } from '~/components/Image/AsPosts/ImagesAsPostsCard';
import {
  ImagesAsPostsInfiniteProvider,
  type ImagesAsPostsSource,
} from '~/components/Image/AsPosts/ImagesAsPostsInfiniteProvider';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { MediaFiltersDropdown } from '~/components/Image/Filters/MediaFiltersDropdown';
import { useImageFilters } from '~/components/Image/image.utils';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useDomainColor } from '~/hooks/useDomainColor';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { removeEmpty } from '~/utils/object-helpers';
import { QS } from '~/utils/qs';
import { trpc } from '~/utils/trpc';
import { GalleryModerationModal } from './GalleryModerationModal';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

type ModelVersionsProps = { id: number; name: string; modelId: number };

export type ImagesAsPostsInfiniteProps = {
  /**
   * Discriminated entity binding. Today the two modes are:
   *   - `model`   — regular Model gallery: versions, resource reviews,
   *                 gallery moderation settings, pinned posts.
   *   - `model3d` — Model3D gallery: no versions, no resource reviews,
   *                 server-side post pre-resolution via Post.model3dId.
   *
   * Driving the entity through a single union (rather than parallel
   * nullable fields) lets the gallery body — and every consumer that reads
   * from the provider — narrow once instead of juggling guards.
   */
  source: ImagesAsPostsSource;
  selectedVersionId?: number;
  username?: string;
  modelVersions?: ModelVersionsProps[];
  showModerationOptions?: boolean;
  showPOIWarning?: boolean;
  canReview?: boolean;
};

const LIMIT = 50;
export function ImagesAsPostsInfinite({
  source,
  username,
  modelVersions,
  selectedVersionId,
  showModerationOptions,
  showPOIWarning,
  canReview,
}: ImagesAsPostsInfiniteProps) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const isMobile = useContainerSmallerThan('sm');
  const limit = isMobile ? LIMIT / 2 : LIMIT;

  const [showHidden, setShowHidden] = useState(false);

  const imageFilters = useImageFilters('modelImages');
  const filters = useMemo(() => {
    const entityFilter =
      source.kind === 'model'
        ? { modelId: source.model.id, modelVersionId: selectedVersionId }
        : { model3dId: source.id };
    return removeEmpty({
      ...imageFilters,
      ...entityFilter,
      username,
      hidden: showHidden, // override global hidden filter
      // types: [MediaType.image, MediaType.video], // override global types image filter
    });
  }, [imageFilters, source, selectedVersionId, username, showHidden]);

  const rawBrowsingLevel = useBrowsingLevelDebounced();
  const domainColor = useDomainColor();
  // On the green (SFW) domain we default to PG only for model galleries.
  // Users opt in to PG-13 via the feed filter; otherwise narrow the forced
  // domain cap (sfwBrowsingLevelsFlag = PG | PG-13) down to PG. Mirrors the
  // logic in ImagesInfinite.tsx so behavior is consistent across feeds.
  const capToPublic = domainColor === 'green' && !filters.includePG13;
  const browsingLevel = capToPublic
    ? Flags.intersection(rawBrowsingLevel, publicBrowsingLevelsFlag)
    : rawBrowsingLevel;
  // model.getGallerySettings is Model-only; pass undefined on other sources
  // so the underlying query is disabled cleanly. The parallel Model3D hook
  // covers `source.kind === 'model3d'` with a flat hidden-image list.
  const settingsModelId = source.kind === 'model' ? source.model.id : undefined;
  const settingsModel3DId = source.kind === 'model3d' ? source.id : undefined;
  const { gallerySettings } = useGallerySettings({ modelId: settingsModelId });
  const { gallerySettings: model3dGallerySettings } = useModel3DGallerySettings({
    model3dId: settingsModel3DId,
  });
  let intersection = browsingLevel;
  if (gallerySettings?.level) {
    intersection = Flags.intersection(browsingLevel, gallerySettings.level);
  }
  // Both Model + Model3D galleries gate on the settings response (so
  // hidden ids/level are applied before the first page request); other
  // sources can start fetching immediately.
  const enabled =
    intersection > 0 &&
    (source.kind === 'model'
      ? !!gallerySettings
      : source.kind === 'model3d'
      ? !!model3dGallerySettings
      : true);
  const { data, isLoading, fetchNextPage, hasNextPage, isRefetching, isFetching } =
    trpc.image.getImagesAsPostsInfinite.useInfiniteQuery(
      { ...filters, limit, browsingLevel: intersection },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        trpc: { context: { skipBatch: true } },
        placeholderData: keepPreviousData,
        enabled,
        // enabled: inView,
      }
    );

  const hiddenUsers = useMemo(
    () =>
      source.kind === 'model3d'
        ? model3dGallerySettings?.hiddenUsers.map((x) => x.id)
        : gallerySettings?.hiddenUsers.map((x) => x.id),
    [source.kind, gallerySettings?.hiddenUsers, model3dGallerySettings?.hiddenUsers]
  );
  const hiddenTags = useMemo(
    () =>
      source.kind === 'model3d'
        ? model3dGallerySettings?.hiddenTags.map((x) => x.id)
        : gallerySettings?.hiddenTags.map((x) => x.id),
    [source.kind, gallerySettings?.hiddenTags, model3dGallerySettings?.hiddenTags]
  );

  // Model: hidden images are keyed by modelVersionId. Model3D: flat list
  // (no version dimension). Both collapse to a `number[]` for the
  // `useApplyHiddenPreferences` consumer below.
  const hiddenImageIds = useMemo(() => {
    if (source.kind === 'model3d') return model3dGallerySettings?.hiddenImages ?? [];
    return selectedVersionId && gallerySettings
      ? gallerySettings.hiddenImages?.[selectedVersionId] ?? []
      : [];
  }, [source.kind, selectedVersionId, gallerySettings, model3dGallerySettings]);

  const flatData = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);
  const { items } = useApplyHiddenPreferences({
    type: 'posts',
    data: flatData,
    hiddenImages: !showHidden ? hiddenImageIds : undefined,
    hiddenUsers: !showHidden ? hiddenUsers : undefined,
    hiddenTags: !showHidden ? hiddenTags : undefined,
    browsingLevel: intersection,
  });

  const handleAddPostClick = (opts?: { reviewing?: boolean }) => {
    const queryString = QS.stringify(
      source.kind === 'model'
        ? {
            modelId: source.model.id,
            modelVersionId: selectedVersionId,
            returnUrl: router.asPath,
            reviewing: opts?.reviewing,
          }
        : { model3dId: source.id, returnUrl: router.asPath }
    );

    router.push(`/posts/create?${queryString}`);
  };

  useEffect(() => {
    if (!hiddenImageIds.length) setShowHidden(false);
  }, [hiddenImageIds]);

  const isMuted = currentUser?.muted ?? false;
  const hasModerationPreferences =
    source.kind === 'model3d'
      ? !!hiddenImageIds.length ||
        !!model3dGallerySettings?.hiddenUsers.length ||
        !!model3dGallerySettings?.hiddenTags.length
      : !!hiddenImageIds.length ||
        !!gallerySettings?.hiddenUsers.length ||
        !!gallerySettings?.hiddenTags.length;

  const providerValue = useMemo(
    () => ({ filters, modelVersions, showModerationOptions, source }),
    [filters, modelVersions, showModerationOptions, source]
  );

  return (
    <ImagesAsPostsInfiniteProvider value={providerValue}>
      <MasonryProvider
        columnWidth={320}
        maxColumnCount={6}
        maxSingleColumnWidth={450}
        style={{ flex: 1 }}
      >
        <MasonryContainer>
          <Stack gap="md">
            <Group gap="xs">
              <Title order={2} data-tour="model:gallery">
                Gallery
              </Title>
              {!isMuted && (
                <Group>
                  <LoginRedirect reason="post-images">
                    <Button
                      variant="outline"
                      size="xs"
                      leftSection={<IconPlus size={16} />}
                      onClick={() => handleAddPostClick()}
                    >
                      Add Post
                    </Button>
                  </LoginRedirect>
                  {canReview && (
                    <LoginRedirect reason="create-review">
                      <Button
                        leftSection={<IconStar size={16} />}
                        variant="outline"
                        size="xs"
                        onClick={() => handleAddPostClick({ reviewing: true })}
                      >
                        Add Review
                      </Button>
                    </LoginRedirect>
                  )}
                </Group>
              )}
              <Group ml="auto" gap={8}>
                <SortFilter type="modelImages" />
                <MediaFiltersDropdown filterType="modelImages" size="compact-sm" hideBaseModels />
                {showModerationOptions &&
                  (source.kind === 'model' || source.kind === 'model3d') && (
                    <>
                      {!!hiddenImageIds.length && (
                        <ButtonTooltip
                          label={`${showHidden ? 'Hide' : 'Show'} hidden images`}
                        >
                          <LegacyActionIcon
                            variant="light"
                            radius="xl"
                            color="red"
                            onClick={() => setShowHidden((h) => !h)}
                          >
                            {showHidden ? <IconEye size={16} /> : <IconEyeOff size={16} />}
                          </LegacyActionIcon>
                        </ButtonTooltip>
                      )}
                      {/* GalleryModerationModal (browsing-level + tag/user
                          pickers) is Model-only — it pivots on Model
                          versions. For Model3D we surface only the
                          per-image hide via the post card context menu. */}
                      {source.kind === 'model' && (
                        <ButtonTooltip label="Gallery Moderation Preferences">
                          <LegacyActionIcon
                            variant="filled"
                            radius="xl"
                            onClick={() =>
                              dialogStore.trigger({
                                component: GalleryModerationModal,
                                props: { modelId: source.model.id },
                              })
                            }
                          >
                            <IconSettings size={16} />
                          </LegacyActionIcon>
                        </ButtonTooltip>
                      )}
                    </>
                  )}
              </Group>
            </Group>
            {showPOIWarning && (
              <Text size="sm" c="dimmed" lh={1.1}>
                This resource is intended to depict a real person. All images that use this resource
                are scanned for mature themes and manually reviewed by a moderator in accordance
                with our{' '}
                <Text component={Link} href="/content/rules/real-people" td="underline">
                  real person policy
                </Text>
                .{' '}
                <Text td="underline" component="span">
                  If you see an image that violates this policy, please report it immediately.
                </Text>
              </Text>
            )}
            {hasModerationPreferences && selectedVersionId ? (
              <Text size="xs" c="dimmed" mt="-md">
                Some images have been hidden based on moderation preferences set by the creator,{' '}
                <Link legacyBehavior href={`/images?modelVersionId=${selectedVersionId}`} passHref>
                  <Anchor inherit span>
                    view all images using this resource
                  </Anchor>
                </Link>
                .
              </Text>
            ) : null}
            <ImageCategories />
            {enabled && isLoading ? (
              <Paper style={{ minHeight: 200, position: 'relative' }}>
                <LoadingOverlay visible zIndex={10} />
              </Paper>
            ) : !!items.length ? (
              <div style={{ position: 'relative' }}>
                <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
                <MasonryColumnsVirtual
                  data={items}
                  imageDimensions={(data) => {
                    const tallestImage = data.images.sort((a, b) => {
                      const aHeight = a.height ?? 0;
                      const bHeight = b.height ?? 0;
                      const aAspectRatio = aHeight > 0 ? (a.width ?? 0) / aHeight : 0;
                      const bAspectRatio = bHeight > 0 ? (b.width ?? 0) / bHeight : 0;
                      if (aAspectRatio < 1 && bAspectRatio >= 1) return -1;
                      if (bAspectRatio < 1 && aAspectRatio <= 1) return 1;
                      if (aHeight === bHeight) return 0;
                      return aHeight > bHeight ? -1 : 1;
                    })[0];

                    const width = tallestImage?.width ?? 450;
                    const height = tallestImage?.height ?? 450;
                    return { width, height };
                  }}
                  adjustHeight={({ height }, data) => {
                    const imageHeight = Math.min(height, 600);
                    return (
                      imageHeight +
                      (data.user.id !== -1 ? 58 : 0) +
                      (data.images.length > 1 ? 8 : 0)
                    );
                  }}
                  maxItemHeight={600}
                  render={ImagesAsPostsCard}
                  itemId={(data) => data.images.map((x) => x.id).join('_')}
                  withAds
                />
                {hasNextPage && (
                  <InViewLoader
                    loadFn={fetchNextPage}
                    loadCondition={!isFetching}
                    style={{ gridColumn: '1/-1' }}
                  >
                    <Center p="xl" style={{ height: 36 }} mt="md">
                      <Loader />
                    </Center>
                  </InViewLoader>
                )}
              </div>
            ) : (
              <Stack align="center" py="lg">
                <ThemeIcon size={128} radius={100}>
                  <IconCloudOff size={80} />
                </ThemeIcon>
                <Text fz={32} align="center">
                  No results found
                </Text>
                <Text align="center">
                  {"Try adjusting your search or filters to find what you're looking for"}
                </Text>
              </Stack>
            )}
          </Stack>
        </MasonryContainer>
      </MasonryProvider>
    </ImagesAsPostsInfiniteProvider>
  );
}
